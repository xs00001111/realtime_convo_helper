const { app, screen } = require('electron');
const Store = require('electron-store');
const { createLogger } = require('./logger');

// Create logger for window state manager
const logger = createLogger('WindowStateManager');

/**
 * Window State Manager for persisting window position, size, and visibility state
 * This helps ensure the window can be found after being minimized for long periods
 */
class WindowStateManager {
  constructor(options = {}) {
    // Default options
    this.defaults = {
      width: options.defaultWidth || 800,
      height: options.defaultHeight || 400,
      x: undefined,
      y: undefined,
      isMinimized: false,
      isVisible: true
    };

    // Create a store instance for window state data
    this.store = new Store({
      name: 'window-state',
      defaults: this.defaults
    });

    this.windowState = {
      width: this.store.get('width', this.defaults.width),
      height: this.store.get('height', this.defaults.height),
      x: this.store.get('x', this.defaults.x),
      y: this.store.get('y', this.defaults.y),
      isMinimized: this.store.get('isMinimized', this.defaults.isMinimized),
      isVisible: this.store.get('isVisible', this.defaults.isVisible)
    };

    logger.info('Window state manager initialized');
  }

  /**
   * Get the managed state with validated position
   */
  getState() {
    // Ensure the window is visible on a display that's still connected
    // Only validate position if app is ready and we have position data
    if (this.windowState.x !== undefined && this.windowState.y !== undefined && app.isReady()) {
      try {
        const displays = screen.getAllDisplays();
        let isVisibleOnAnyDisplay = false;

        // Check if window is visible on any connected display
        for (const display of displays) {
          const bounds = display.bounds;
          if (
            this.windowState.x >= bounds.x &&
            this.windowState.y >= bounds.y &&
            this.windowState.x + this.windowState.width <= bounds.x + bounds.width &&
            this.windowState.y + this.windowState.height <= bounds.y + bounds.height
          ) {
            isVisibleOnAnyDisplay = true;
            break;
          }
        }

        // Reset position if window is not visible on any display
        if (!isVisibleOnAnyDisplay) {
          logger.info('Window position is outside visible displays, resetting position');
          delete this.windowState.x;
          delete this.windowState.y;
        }
      } catch (error) {
        logger.error('Error validating window position:', error);
        // If there's an error, just return the state without validation
      }
    }

    return this.windowState;
  }

  /**
   * Save the current state of the window
   */
  saveState(win) {
    if (!win) {
      logger.warn('No window provided to saveState');
      return;
    }

    try {
      // Don't update state if window is being closed
      if (win.isDestroyed()) return;

      // Get window state
      const isMinimized = win.isMinimized();
      const isVisible = win.isVisible();
      
      // Get window bounds only if it's not minimized
      let bounds;
      if (!isMinimized) {
        bounds = win.getBounds();
      }

      // Update our state object
      if (bounds) {
        this.windowState.width = bounds.width;
        this.windowState.height = bounds.height;
        this.windowState.x = bounds.x;
        this.windowState.y = bounds.y;
      }
      
      this.windowState.isMinimized = isMinimized;
      this.windowState.isVisible = isVisible;

      // Save to store
      this.store.set('width', this.windowState.width);
      this.store.set('height', this.windowState.height);
      this.store.set('x', this.windowState.x);
      this.store.set('y', this.windowState.y);
      this.store.set('isMinimized', isMinimized);
      this.store.set('isVisible', isVisible);

      logger.debug('Window state saved', {
        size: `${this.windowState.width}x${this.windowState.height}`,
        position: `(${this.windowState.x},${this.windowState.y})`,
        isMinimized,
        isVisible
      });
    } catch (error) {
      logger.error('Error saving window state:', error);
    }
  }

  /**
   * Track window state changes
   */
  trackWindow(win) {
    if (!win) {
      logger.warn('No window provided to trackWindow');
      return;
    }

    // Set up event listeners to track window state
    ['resize', 'move', 'close'].forEach(event => {
      win.on(event, () => {
        this.saveState(win);
      });
    });

    // Special handling for minimize/restore events
    win.on('minimize', () => {
      this.windowState.isMinimized = true;
      this.store.set('isMinimized', true);
      logger.debug('Window minimized');
    });

    win.on('restore', () => {
      this.windowState.isMinimized = false;
      this.store.set('isMinimized', false);
      logger.debug('Window restored');
    });

    // Track visibility changes
    win.on('show', () => {
      this.windowState.isVisible = true;
      this.store.set('isVisible', true);
      logger.debug('Window shown');
    });

    win.on('hide', () => {
      this.windowState.isVisible = false;
      this.store.set('isVisible', false);
      logger.debug('Window hidden');
    });

    // Track blur/focus events
    win.on('blur', () => {
      logger.debug('Window blurred');
    });

    win.on('focus', () => {
      logger.debug('Window focused');
    });

    // Save state periodically (every 30 seconds)
    const stateUpdateInterval = setInterval(() => {
      if (!win.isDestroyed()) {
        this.saveState(win);
      } else {
        clearInterval(stateUpdateInterval);
      }
    }, 30000);

    // Initial state save
    this.saveState(win);
  }
}

module.exports = WindowStateManager;