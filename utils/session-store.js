const Store = require('electron-store');
const { createLogger } = require('./logger');

// Create logger for session store
const logger = createLogger('SessionStore');

// Create a store instance for session data
const sessionStore = new Store({
  name: 'session-data',
  encryptionKey: 'interview-helper-secure-key', // For basic encryption of sensitive data
});

/**
 * Session storage service for persisting authentication sessions
 */
class SessionStoreService {
  /**
   * Save session data to persistent storage
   * @param {Object} session - The session object to store
   * @param {Object} subscription - The subscription object to store (optional)
   */
  saveSession(session, subscription = null) {
    try {
      if (!session) {
        logger.warn('Attempted to save null or undefined session');
        return false;
      }
      
      // Store the session data
      sessionStore.set('session', session);
      
      // Store the subscription data if provided
      if (subscription) {
        sessionStore.set('subscription', subscription);
        logger.info('Subscription saved with session');
      }
      
      // Store the timestamp when this session was saved
      sessionStore.set('sessionSavedAt', new Date().toISOString());
      
      logger.info('Session saved successfully');
      return true;
    } catch (error) {
      logger.error('Failed to save session:', error);
      return false;
    }
  }

  /**
   * Load session data from persistent storage
   * @returns {Object|null} The stored session or null if not found
   */
  loadSession() {
    try {
      const session = sessionStore.get('session');
      
      if (session) {
        logger.info('Session loaded from storage');
        return session;
      }
      
      logger.info('No saved session found');
      return null;
    } catch (error) {
      logger.error('Failed to load session:', error);
      return null;
    }
  }

  /**
   * Load subscription data from persistent storage
   * @returns {Object|null} The stored subscription or null if not found
   */
  loadSubscription() {
    try {
      const subscription = sessionStore.get('subscription');
      
      if (subscription) {
        logger.info('Subscription loaded from storage');
        return subscription;
      }
      
      logger.info('No saved subscription found');
      return null;
    } catch (error) {
      logger.error('Failed to load subscription:', error);
      return null;
    }
  }

  /**
   * Clear the stored session data
   */
  clearSession() {
    try {
      sessionStore.delete('session');
      sessionStore.delete('subscription');
      sessionStore.delete('sessionSavedAt');
      logger.info('Session and subscription cleared successfully');
      return true;
    } catch (error) {
      logger.error('Failed to clear session:', error);
      return false;
    }
  }

  /**
   * Check if there is a stored session
   * @returns {Boolean} True if a session exists in storage
   */
  hasStoredSession() {
    return sessionStore.has('session');
  }

  /**
   * Get the timestamp when the session was last saved
   * @returns {String|null} ISO timestamp or null if not available
   */
  getSessionSavedTimestamp() {
    return sessionStore.get('sessionSavedAt', null);
  }
}

module.exports = new SessionStoreService();