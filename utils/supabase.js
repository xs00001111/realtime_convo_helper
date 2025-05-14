const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
let supabaseUrl = process.env.SUPABASE_URL;
let supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Log environment variable status for debugging
console.log('[Supabase] Environment variables status:');
console.log('- SUPABASE_URL available:', !!supabaseUrl);
console.log('- SUPABASE_ANON_KEY available:', !!supabaseAnonKey);

// Fallback values for development/testing (only if environment variables are not set)
if (!supabaseUrl) {
    supabaseUrl = 'https://aqhcipqqdtchivmbxrap.supabase.co';
    console.log('[Supabase] Using fallback URL');
}

if (!supabaseAnonKey) {
    supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxaGNpcHFxZHRjaGl2bWJ4cmFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDE3NzE0NDUsImV4cCI6MjA1NzM0NzQ0NX0.ABSLZyrZ-8LojAriQKlJALmsgChKagrPLXzVabf559Q';
    console.log('[Supabase] Using fallback Anon Key');
}

// Create a function to create and return the Supabase client
function createSupabaseClient() {
    try {
        if (!supabaseUrl || !supabaseAnonKey) {
            console.error('[Supabase] Missing credentials even after fallback');
            throw new Error('Missing Supabase credentials');
        }
        
        // Create Supabase client instance
        const supabase = createClient(supabaseUrl, supabaseAnonKey);
        console.log('[Supabase] Client created successfully');
        return supabase;
    } catch (error) {
        console.error('[Supabase] Error creating client:', error.message);
        throw error;
    }
}

// Authentication service
const AuthService = {
    /**
     * Sign up a new user
     * @param {string} email 
     * @param {string} password 
     * @returns {Promise}
     */
    signUp: async (email, password) => {
        const supabase = createSupabaseClient();
        const { data, error } = await supabase.auth.signUp({
            email,
            password
        });
        if (error) throw error;
        return data;
    },

    /**
     * Sign in a user
     * @param {string} email 
     * @param {string} password 
     * @returns {Promise}
     */
    signIn: async (email, password) => {
        const supabase = createSupabaseClient();
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        if (error) throw error;
        return data;
    },

    /**
     * Sign out the current user
     * @returns {Promise}
     */
    signOut: async () => {
        const supabase = createSupabaseClient();
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
    },

    /**
     * Reset password for a user
     * @param {string} email 
     * @returns {Promise}
     */
    resetPassword: async (email) => {
        const supabase = createSupabaseClient();
        const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/landing/index.html'
        });
        if (error) throw error;
        return data;
    },

    /**
     * Get the current session
     * @returns {Promise}
     */
    getSession: async () => {
        const supabase = createSupabaseClient();
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;
        return session;
    },

    /**
     * Get the current user
     * @returns {Object|null}
     */
    getCurrentUser: () => {
        const supabase = createSupabaseClient();
        return supabase.auth.user();
    },

    /**
     * Subscribe to auth state changes
     * @param {Function} callback 
     */
    onAuthStateChange: (callback) => {
        const supabase = createSupabaseClient();
        return supabase.auth.onAuthStateChange(callback);
    }
};

module.exports = {
    createSupabaseClient,
    AuthService
};