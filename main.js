const { app, BrowserWindow, screen, ipcMain, globalShortcut, dialog, desktopCapturer } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const { createLogger } = require('./utils/logger');


// Create logger for main process
const logger = createLogger('Main');

// Global reference to the server process
let serverProcess;

// Keep a global reference of the window object to prevent garbage collection
let mainWindow;

// Track window visibility state
let isWindowVisible = true;

// Track app quitting state
app.isQuitting = false;

// Store window position and size for restoration
let windowState = {
  position: null,
  size: null
};

// Create temp directory for screenshots
const screenshotDir = path.join(os.tmpdir(), 'app-screenshots');
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

// Function to take a screenshot
async function takeScreenshot(processAfterCapture = false) {
  if (!mainWindow) return;
  
  let screenshotPath = "";
  
  try {
    // Hide the app window temporarily to avoid it appearing in the screenshot
    const wasVisible = mainWindow.isVisible();
    if (wasVisible) {
      // Store window position and size
      windowState.position = mainWindow.getPosition();
      windowState.size = mainWindow.getSize();
      mainWindow.hide();
    }
    
    // Reduced delay to minimize latency while still ensuring window is hidden
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Get screenshot buffer using native methods based on platform
    const screenshotBuffer = 
      process.platform === "darwin" 
        ? await captureScreenshotMac() 
        : await captureScreenshotWindows();
    
    // Pin functionality removed
    
    // Generate a unique filename using timestamp
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    screenshotPath = path.join(screenshotDir, `screenshot-${timestamp}.png`);
    
    // Save the screenshot to the temp directory
    fs.writeFileSync(screenshotPath, screenshotBuffer);
    
    // Verify the file was written correctly
    const stats = fs.statSync(screenshotPath);
    if (stats.size === 0) {
      logger.error('Screenshot file was created but is empty');
      if (mainWindow) {
        mainWindow.webContents.send('error', { message: 'Failed to save screenshot: File is empty' });
      }
      return;
    }
    
    logger.info(`Screenshot saved to: ${screenshotPath} (${stats.size} bytes)`);
    
    // Manage screenshot queue (keeping only the most recent screenshots)
    const MAX_SCREENSHOTS = 5; // Reduced from 10 to minimize disk usage and improve performance
    const screenshotFiles = fs.readdirSync(screenshotDir)
      .filter(file => file.startsWith('screenshot-'))
      .map(file => path.join(screenshotDir, file));
    
    // Sort by creation time (oldest first)
    screenshotFiles.sort((a, b) => {
      return fs.statSync(a).mtime.getTime() - fs.statSync(b).mtime.getTime();
    });
    
    // Remove oldest screenshots if we have too many
    if (screenshotFiles.length > MAX_SCREENSHOTS) {
      const filesToRemove = screenshotFiles.slice(0, screenshotFiles.length - MAX_SCREENSHOTS);
      for (const fileToRemove of filesToRemove) {
        try {
          fs.unlinkSync(fileToRemove);
          logger.debug(`Removed old screenshot: ${fileToRemove}`);
        } catch (error) {
          logger.error(`Error removing old screenshot: ${error}`, error);
        }
      }
    }
    
    // Show the main window again if it was visible before
    if (wasVisible && mainWindow) {
      // Minimal delay before showing window again to reduce latency
      await new Promise(resolve => setTimeout(resolve, 25));
      mainWindow.show();
      if (windowState.position) {
        mainWindow.setPosition(windowState.position[0], windowState.position[1]);
      }
      if (windowState.size) {
        mainWindow.setSize(windowState.size[0], windowState.size[1]);
      }
    }
    
    // Notify the renderer process that the screenshot was taken
    if (mainWindow) {
      mainWindow.webContents.send('screenshot-taken', { 
  path: screenshotPath, 
  isShortcut: processAfterCapture 
});
    }
    
    // If processAfterCapture is true, send the screenshot to the server for processing
    if (processAfterCapture && serverProcess) {
      logger.info('Sending screenshot to server for processing...');
      serverProcess.send({ type: 'process-screenshot', data: { path: screenshotPath } });
      if (mainWindow) {
        mainWindow.webContents.send('processing-screenshot', { message: 'Processing screenshot...' });
      }
    }
    
    return screenshotPath;
  } catch (err) {
    logger.error('Failed to capture screenshot:', err);
    if (mainWindow) {
      mainWindow.webContents.send('error', { message: `Failed to capture screenshot: ${err.message}` });
    }
    throw err;
  }
}

// Platform-specific screenshot capture for macOS
async function captureScreenshotMac() {
  try {
    // Create a temporary file path for the screenshot
    const tempPath = path.join(screenshotDir, `temp-${Date.now()}.png`);
    
    // Use the screencapture utility on macOS with optimized options
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      // Using execFile instead of exec for better performance and security
      // -x: no sound, -t: png format (faster than default), -C: no cursor
      execFile('screencapture', ['-x', '-t', 'png', '-C', tempPath], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    
    // Read the file and return as buffer
    return fs.readFileSync(tempPath);
  } catch (error) {
    logger.error('Error capturing screenshot on macOS:', error);
    throw error;
  }
}

// Platform-specific screenshot capture for Windows
async function captureScreenshotWindows() {
  try {
    // Use Electron's desktopCapturer for Windows
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      thumbnailSize: screen.getPrimaryDisplay().workAreaSize 
    });
    
    // Get the primary display source
    const primarySource = sources[0];
    
    // Create a new BrowserWindow to capture the entire screen
    const captureWindow = new BrowserWindow({
      width: screen.getPrimaryDisplay().workAreaSize.width,
      height: screen.getPrimaryDisplay().workAreaSize.height,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        offscreen: true
      }
    });
    
    // Capture the entire screen
    const screenshot = await captureWindow.webContents.capturePage({
      x: 0,
      y: 0,
      width: screen.getPrimaryDisplay().bounds.width,
      height: screen.getPrimaryDisplay().bounds.height
    });
    
    // Close the capture window
    captureWindow.close();
    
    return screenshot.toPNG();
  } catch (error) {
    logger.error('Error capturing screenshot on Windows:', error);
    throw error;
  }
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // Create the browser window with enhanced undetectability features
  mainWindow = new BrowserWindow({
    width: 800,
    height: 400,
    x: Math.floor((width - 800) / 2),
    y: height - 450,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000', // Fully transparent background
    hasShadow: false, // Disable window shadow
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true, // Hide from taskbar/dock
    type: 'panel', // Less detectable window type
    visibleOnAllWorkspaces: true, // Visible on all virtual desktops
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: app.isPackaged 
        ? path.join(process.resourcesPath, 'preload.js') 
        : path.join(__dirname, 'preload.js'),
      backgroundThrottling: false // Prevent throttling when in background
    }
  });

  // Apply platform-specific undetectability settings
  if (process.platform === 'darwin') {
    // macOS specific settings
    mainWindow.setHiddenInMissionControl(true); // Hide from Mission Control
  }

  // Enable content protection to prevent screen capture
  mainWindow.setContentProtection(true);

  // Load index.html directly
  mainWindow.loadURL('file://' + path.join(__dirname, 'index.html'));

  // Open DevTools in development
   // mainWindow.webContents.openDevTools();

  // Emitted when the window is closed
  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  // Allow window to be draggable
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    mainWindow.setIgnoreMouseEvents(ignore, options || { forward: true });
  });
  
  // Handle window resize
  ipcMain.on('resize-window', (event, width, height) => {
    if (mainWindow) {
      mainWindow.setSize(width, height);
    }
  });
  
  // Handle window move
  ipcMain.on('move-window', (event, x, y) => {
    if (mainWindow) {
      const [currentX, currentY] = mainWindow.getPosition();
      mainWindow.setPosition(currentX + x, currentY + y);
    }
  });
  
  // Get window size
  ipcMain.handle('get-window-size', () => {
    if (mainWindow) {
      return mainWindow.getSize();
    }
    return [800, 200]; // Default size
  });
  
  // Get window position
  ipcMain.handle('get-window-position', () => {
    if (mainWindow) {
      return mainWindow.getPosition();
    }
    return [0, 0]; // Default position
  });

  // Handle minimize button click
  ipcMain.on('minimize', () => {
    mainWindow.minimize();
  });

  // Handle close button click
  ipcMain.on('close', () => {
    app.quit();
  });
  
  // Handle start recording button click
  ipcMain.on('start-recording', () => {
    if (serverProcess) {
      serverProcess.send({ type: 'start-recording' });
    }
  });
  
  // Handle stop recording button click
  ipcMain.on('stop-recording', () => {
    if (serverProcess) {
      // Send stop recording message to server process
      serverProcess.send({ type: 'stop-recording' });
      
      // Immediately send recording status update to the renderer
      // This ensures UI updates even if there's an issue with the server process
      if (mainWindow) {
        mainWindow.webContents.send('recording-status', { isRecording: false });
      }
      
      // Add a timeout to check if recording was successfully stopped
      setTimeout(() => {
        if (serverProcess) {
          // Send a ping to check if server is still alive
          try {
            serverProcess.send({ type: 'ping' });
          } catch (error) {
            console.error('Error pinging server process:', error);
            // If we can't communicate with the server, it might have crashed
            // Restart it
            startServerProcess();
          }
        }
      }, 1000);
    }
  });
  
  // Handle send to server
  ipcMain.on('send-to-server', (event, message) => {
    if (serverProcess) {
      serverProcess.send(message);
    }
  });}
  
  // Handle set context from text
  ipcMain.on('set-context-text', (event, text) => {
    if (serverProcess) {
      serverProcess.send({ type: 'set-context', data: { text } });
    }
  });
  
  // Handle file dialog open request
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Text Files', extensions: ['txt', 'md', 'json'] },
        { name: 'Documents', extensions: ['pdf', 'docx'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }
      ]
    });
    return result;
  });
  
  // Handle elaboration request
  ipcMain.on('elaborate', (event, message) => {
    console.log('[DEBUG] Main process received elaborate request:', message);
    if (serverProcess) {
      serverProcess.send({ type: 'elaborate', data: { message } });
    }
  });
  
  // Handle get-suggestion request
  ipcMain.on('get-suggestion', (event, data) => {
    console.log('[DEBUG] Main process received get-suggestion request:', data);
    if (serverProcess) {
      console.log('[DEBUG] Forwarding get-suggestion request to server process');
      serverProcess.send({ type: 'get-suggestion', data });
    } else {
      console.error('[DEBUG] Cannot forward get-suggestion request: server process not available');
      if (mainWindow) {
        mainWindow.webContents.send('error', { message: 'Server process is not available. Please restart the application.' });
      }
    }
  });

  // Handle set context from file
  ipcMain.on('set-context-file', (event, filePath) => {
    console.log('Received file path in main process:', filePath);
    
    // If the file path is just a filename (not a full path), we need to handle it differently
    if (!filePath.includes('/') && !filePath.includes('\\')) {
      console.log('File path appears to be just a filename, not a full path');
      // In a real implementation, you might want to show a dialog to select the file
      // For now, we'll just send an error back to the renderer
      if (mainWindow) {
        mainWindow.webContents.send('error', { message: 'Could not access full file path. Please try again.' });
      }
      return;
    }
    
    if (serverProcess) {
      serverProcess.send({ type: 'set-context', data: { file: filePath } });
    }
  });


// Import the AuthService class
const AuthService = require('./services/auth-service');

// Create an instance of the AuthService
let authService = null;

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {

  // Now you can initialize your AuthService and it will use the environment variables
  authService = new AuthService();
  
  // Handle auth events
  authService.on('auth-success', (session) => {
    if (mainWindow) {
      mainWindow.webContents.send('auth-success', session);
      mainWindow.webContents.send('ready', { message: 'Authentication successful' });
    }
  });
  
  authService.on('auth-error', (message) => {
    if (mainWindow) {
      mainWindow.webContents.send('auth-error', { message });
    }
  });
  
  authService.on('subscription-error', (message) => {
    if (mainWindow) {
      mainWindow.webContents.send('auth-error', { message: 'You need to purchase a subscription to use this application.' });
    }
  });
  
  // Initialize auth service and check for existing session
  logger.info('Initializing auth service and checking for existing session');
  const hasValidSession = await authService.initialize();
  
  if (hasValidSession) {
    logger.info('Valid session found, user is already authenticated');
  } else {
    logger.info('No valid session found, user needs to authenticate');
    // Notify the renderer process that authentication is required
    if (mainWindow) {
      setTimeout(() => {
        mainWindow.webContents.send('auth-required', { message: 'Authentication required' });
      }, 1000); // Short delay to ensure window is ready
    }
  }
  
  // Register the complete-login handler
  ipcMain.handle('complete-login', async (event, data) => {
    console.log('[MAIN] Handling complete-login with data:', data);
    try {
      const { email, password } = data;
      const success = await authService.signInWithEmailPassword(email, password);
      return { success };
    } catch (error) {
      console.error('[MAIN] Error in complete-login handler:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Register the check-session handler
  ipcMain.handle('check-session', async () => {
    logger.info('[MAIN] Checking session validity');
    try {
      const isValid = authService.hasValidSession();
      logger.info(`[MAIN] Session validity check: ${isValid}`);
      return isValid;
    } catch (error) {
      logger.error('[MAIN] Error checking session validity:', error);
      return false;
    }
  });
  
  createWindow();
  
  // Register keyboard shortcuts for window movement
  globalShortcut.register('CommandOrControl+Up', () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x, y - 10);
    }
  });
  
  globalShortcut.register('CommandOrControl+Down', () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x, y + 10);
    }
  });
  
  globalShortcut.register('CommandOrControl+Left', () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x - 10, y);
    }
  });
  
  globalShortcut.register('CommandOrControl+Right', () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x + 10, y);
    }
  });
  
  // Register keyboard shortcut for toggling window visibility (⌘+B on Mac, Control+B on Windows)
  globalShortcut.register('CommandOrControl+B', () => {
    toggleWindowVisibility();
  });
  
  // Register keyboard shortcut for quitting the application (⌘+Q on Mac, Control+Q on Windows)
  globalShortcut.register('CommandOrControl+Q', () => {
    app.quit();
  });
  
  // Register keyboard shortcut for taking screenshots (⌘+H on Mac, Control+H on Windows)
  globalShortcut.register('CommandOrControl+H', () => {
    takeScreenshot(false);
  });
  
  // Register keyboard shortcut for taking and processing screenshots (⌘+Enter on Mac, Control+Enter on Windows)
  globalShortcut.register('CommandOrControl+Enter', () => {
    takeScreenshot(true);
  });
  
  // Register keyboard shortcut for quick hide (Escape key)
  globalShortcut.register('Escape', () => {
    if (mainWindow && isWindowVisible) {
      // Quick hide with opacity
      mainWindow.setOpacity(0);
      mainWindow.setIgnoreMouseEvents(true);
      isWindowVisible = false;
    }
  });
  
  // Function to set up all server process event handlers
  function setupServerProcessHandlers(process) {
    // Add error handling for the server process
    process.on('error', (error) => {
      logger.error('Server process error:', error);
      if (mainWindow) {
        mainWindow.webContents.send('error', { message: `Server process error: ${error.message}` });
      }
    });
    
    // Handle server process exit
    process.on('exit', (code, signal) => {
      logger.error(`Server process exited with code ${code} and signal ${signal}`);
      
      // Only show error to user if this wasn't a normal shutdown
      if (mainWindow && !app.isQuitting && code !== 0) {
        mainWindow.webContents.send('error', { message: `Server process exited unexpectedly` });
      }
      
      // Restart the server process if it exits unexpectedly and app is not quitting
      if (!app.isQuitting) {
        logger.info('Attempting to restart server process...');
        
        // Short delay before restarting to avoid rapid restart cycles
        setTimeout(() => {
          // Create a new server process with the same configuration
          serverProcess = fork(serverPath, [], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
          });
          
          // Re-attach all the event handlers
          setupServerProcessHandlers(serverProcess);
          
          // Notify the renderer that we're reconnecting
          if (mainWindow) {
            mainWindow.webContents.send('server-reconnecting');
          }
        }, 1000);
      }
    });
    
    // Handle messages from the server process
    process.on('message', (message) => {
      if (message.type === 'transcript' && mainWindow) {
        mainWindow.webContents.send('transcript', message.data);
      } else if (message.type === 'suggestion' && mainWindow) {
        mainWindow.webContents.send('suggestion', message.data);
      } else if (message.type === 'suggestion-chunk' && mainWindow) {
        // Handle streaming chunks from OpenAI
        mainWindow.webContents.send('suggestion-chunk', message.data);
      } else if (message.type === 'recording-status' && mainWindow) {
        mainWindow.webContents.send('recording-status', message.data);
      } else if (message.type === 'context-update' && mainWindow) {
        mainWindow.webContents.send('context-update', message.data);
      } else if (message.type === 'error' && mainWindow) {
        mainWindow.webContents.send('error', message.data);
      } else if (message.type === 'ready' && mainWindow) {
        mainWindow.webContents.send('ready', message.data);
      } else if (message.type === 'screenshot-processed' && mainWindow) {
        mainWindow.webContents.send('screenshot-processed', message.data);
      } else if (message.type === 'processing-screenshot' && mainWindow) {
        mainWindow.webContents.send('processing-screenshot', message.data);
      } else if (message.type === 'elaboration' && mainWindow) {
        mainWindow.webContents.send('elaboration', message.data);
      } else if (message.type === 'pong') {
        logger.debug('Received pong from server process - server is alive');
      }
    });
    
    // Log server output
    process.stdout.on('data', (data) => {
      logger.info(`[Server]: ${data}`);
    });
    
    process.stderr.on('data', (data) => {
      logger.error(`[Server Error]: ${data}`);
    });
  }
  
  // Start the server process
  const serverPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'server.js')
    : path.join(__dirname, 'server.js');

  logger.info(`Starting server process from: ${serverPath}`);
  
  // Fork the server process
  serverProcess = fork(serverPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });
  
  // Set up all the event handlers
  setupServerProcessHandlers(serverProcess);
  
  // Log when server is ready
  logger.info('Server process setup complete, waiting for ready signal...');

  app.on('activate', function () {
    // On macOS it's common to re-create a window when the dock icon is clicked
    if (mainWindow === null) createWindow();
    mainWindow.on('ready-to-show', () => {
      if (!process.env.IS_TEST) mainWindow.show();
      
      // Check existing session validity
      checkExistingSession()
        .then(isValid => {
          mainWindow.webContents.send('session-status', isValid);
          logger.info(`Session validity check completed: ${isValid}`);
        })
        .catch(error => {
          logger.error('Session check failed:', error);
          mainWindow.webContents.send('session-status', false);
        });
    });
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.isQuitting = true;
    app.quit();
  }
});

// Handle before-quit event to clean up resources
app.on('before-quit', () => {
  logger.info('Application is about to quit');
  app.isQuitting = true;
  if (serverProcess) {
    try {
      logger.info('Removing server process listeners and terminating process');
      serverProcess.removeAllListeners();
      serverProcess.kill();
      logger.info('Server process terminated successfully');
    } catch (error) {
      logger.error('Error killing server process:', error);
    }
  }
});

// Clean up the server process when the app is quitting
app.on('quit', () => {
  logger.info('Application quit event triggered');
  if (serverProcess) {
    try {
      serverProcess.kill();
      logger.info('Server process killed during quit');
    } catch (error) {
      logger.error('Error killing server process during quit:', error);
    }
  }
  
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
  logger.info('Global shortcuts unregistered');
});

// Enhanced function to toggle window visibility with undetectability features
function toggleWindowVisibility() {
  if (!mainWindow) {
    // If window was closed, recreate it
    createWindow();
    isWindowVisible = true;
    return;
  }
  
  if (isWindowVisible) {
    // Store current window state before hiding
    windowState.position = mainWindow.getPosition();
    windowState.size = mainWindow.getSize();
    
    // Hide the window using opacity for smoother transition
    mainWindow.setOpacity(0);
    // Ignore mouse events when hidden
    mainWindow.setIgnoreMouseEvents(true);
    isWindowVisible = false;
  } else {
    // Restore mouse event handling
    mainWindow.setIgnoreMouseEvents(false);
    // Show the window with opacity transition
    mainWindow.setOpacity(1);
    
    // Restore previous position and size if available
    if (windowState.position) {
      mainWindow.setPosition(windowState.position[0], windowState.position[1]);
    }
    
    if (windowState.size) {
      mainWindow.setSize(windowState.size[0], windowState.size[1]);
    }
    
    isWindowVisible = true;
  }
}

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.isQuitting = true;
    app.quit();
  }
});

// Handle before-quit event to clean up resources
app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) {
    try {
      serverProcess.removeAllListeners();
      serverProcess.kill();
    } catch (error) {
      console.error('Error killing server process:', error);
    }
  }
});

function checkExistingSession() {
  const sessionStore = require('./utils/session-store');
  return new Promise((resolve) => {
    try {
      // Check if there's a stored session since validateSession doesn't exist
      const isValid = sessionStore.hasStoredSession();
      resolve(isValid);
    } catch (error) {
      logger.error('Session validation error:', error);
      resolve(false);
    }
  });
}