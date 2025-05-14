const electronLog = require('electron-log');
const path = require('path');
const os = require('os');

// Configure electron-log
// By default, electron-log writes logs to the following locations:
// on Linux: ~/.config/{app name}/logs/{process type}.log
// on macOS: ~/Library/Logs/{app name}/{process type}.log
// on Windows: %USERPROFILE%\AppData\Roaming\{app name}\logs\{process type}.log

// Set maximum log size to 10MB
electronLog.transports.file.maxSize = 10 * 1024 * 1024;

// Archive old log files
electronLog.transports.file.archiveLog = (oldPath) => {
  const newPath = `${oldPath}.old`;
  return newPath;
};

// Format log messages
electronLog.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{processType}] {text}';

// Set log level based on environment
electronLog.transports.file.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

// Also log to console in development mode
electronLog.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

// Add system info to the log
const systemInfo = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  electronVersion: process.versions.electron,
  appPath: process.execPath,
  resourcesPath: process.resourcesPath || 'Not available',
  appDirectory: process.cwd(),
  homeDir: os.homedir(),
  tempDir: os.tmpdir(),
  username: os.userInfo().username,
  env: process.env.NODE_ENV || 'Not set'
};

// Log system info on startup
electronLog.info('Application started with system info:', systemInfo);
electronLog.info('Process arguments:', process.argv);
electronLog.info('Environment PATH:', process.env.PATH);

// Create a logger instance with context
function createLogger(context) {
  return {
    info: (message, ...args) => electronLog.info(`[${context}] ${message}`, ...args),
    warn: (message, ...args) => electronLog.warn(`[${context}] ${message}`, ...args),
    error: (message, ...args) => electronLog.error(`[${context}] ${message}`, ...args),
    debug: (message, ...args) => electronLog.debug(`[${context}] ${message}`, ...args),
    verbose: (message, ...args) => electronLog.verbose(`[${context}] ${message}`, ...args),
    silly: (message, ...args) => electronLog.silly(`[${context}] ${message}`, ...args),
    // Add a method to log errors with stack traces
    errorWithStack: (message, error) => {
      const stack = error && error.stack ? error.stack : 'No stack trace available';
      electronLog.error(`[${context}] ${message}\n${stack}`);
    }
  };
}

module.exports = {
  createLogger,
  log: electronLog
};