const { createSupabaseClient } = require('./supabase');

/**
 * User plan types and their interfaces
 */

/**
 * @typedef {Object} UserPlan
 * @property {'free' | 'pay_as_you_go' | 'guaranteed_job'} plan_type - Type of plan
 * @property {number} interviews_remaining - Number of interviews remaining (-1 for unlimited)
 * @property {number} minutes_per_interview - Maximum minutes per interview
 * @property {string|null} expires_at - Expiration date (ISO string) or null if no expiration
 */

/**
 * @typedef {Object} PlanLimits
 * @property {number} maxInterviews - Maximum number of interviews allowed
 * @property {number} maxMinutesPerInterview - Maximum minutes per interview
 * @property {boolean} isUnlimited - Whether the plan has unlimited interviews
 */

/**
 * @typedef {Object} PlanStatus
 * @property {boolean} canStart - Whether user can start a new interview
 * @property {string} [reason] - Reason why user cannot start (if applicable)
 * @property {Object} plan - Plan details
 * @property {string} plan.type - Plan type
 * @property {number} plan.interviewsRemaining - Number of interviews remaining
 * @property {number} plan.minutesPerInterview - Minutes per interview
 * @property {boolean} plan.isExpired - Whether plan is expired
 * @property {string|null} plan.expiresAt - Expiration date or null
 */

/**
 * Get the user's current plan from Supabase
 * @param {string} userId - The user ID
 * @returns {Promise<UserPlan|null>} The user plan or null if not found
 */
async function getUserPlan(userId) {
  console.log(`[Plan] Attempting to get plan for user ID: ${userId}`); // Log User ID
  try {
    const supabase = createSupabaseClient();
    console.log(`[Plan] Supabase client created: ${!!supabase}`); // Log client creation status
    
    // Use maybeSingle() instead of single() to avoid errors when no rows are found
    const { data: plan, error } = await supabase
      .from('user_plans')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    console.log(`[Plan] Supabase query result - Data:`, plan); // Log data
    console.log(`[Plan] Supabase query result - Error:`, error); // Log error

    if (error && error.code !== 'PGRST116') {
      console.error(`[Plan] Supabase query error (excluding PGRST116):`, error); // Log specific error
      // Only throw for errors other than 'no rows returned'
      throw error;
    }

    // If no plan is found, return a default free plan
    if (!plan) {
      console.log(`[Plan] No plan found for user ${userId} in DB, using default free plan`); // Adjusted log message
      return {
        user_id: userId,
        plan_type: 'free',
        interviews_remaining: 10,
        minutes_per_interview: 5,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }

    console.log(`[Plan] Plan found for user ${userId}:`, plan); // Log found plan
    return plan;
  } catch (error) {
    console.error(`[Plan] Error caught in getUserPlan for user ${userId}:`, error); // Log caught error
    // Return a default free plan in case of error
    return {
      user_id: userId,
      plan_type: 'free',
      interviews_remaining: 10,
      minutes_per_interview: 5,
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }
}

/**
 * Check the user's plan limits
 * @param {string} userId - The user ID
 * @returns {Promise<PlanLimits>} The plan limits
 */
async function checkUserPlan(userId) {
  try {
    // getUserPlan now always returns a plan (either from DB or default)
    const plan = await getUserPlan(userId);
    
    // Check if guaranteed job plan is expired
    if (plan.plan_type === 'guaranteed_job' && plan.expires_at && new Date(plan.expires_at) < new Date()) {
      return {
        maxInterviews: 10,
        maxMinutesPerInterview: 5,
        isUnlimited: false
      };
    }

    // Unlimited plan
    if (plan.plan_type === 'guaranteed_job' || plan.interviews_remaining === -1) {
      return {
        maxInterviews: Infinity,
        maxMinutesPerInterview: Infinity,
        isUnlimited: true
      };
    }

    return {
      maxInterviews: plan.interviews_remaining,
      maxMinutesPerInterview: plan.minutes_per_interview,
      isUnlimited: false
    };
  } catch (error) {
    console.error('Error checking plan:', error);
    // Default to free tier limits
    return {
      maxInterviews: 10,
      maxMinutesPerInterview: 5,
      isUnlimited: false
    };
  }
}

/**
 * Get the user's plan status
 * @param {string} userId - The user ID
 * @returns {Promise<PlanStatus>} The plan status
 */
async function getPlanStatus(userId) {
  try {
    // getUserPlan now always returns a plan (either from DB or default)
    const plan = await getUserPlan(userId);
    

    const isExpired = plan.expires_at ? new Date(plan.expires_at) < new Date() : false;
    const isUnlimited = plan.plan_type === 'guaranteed_job' || plan.interviews_remaining === -1;

    // Check if plan is expired (only applies to guaranteed job plan)
    if (plan.plan_type === 'guaranteed_job' && isExpired) {
      return {
        canStart: false,
        reason: 'Your guaranteed job plan has expired',
        plan: {
          type: plan.plan_type,
          interviewsRemaining: 0,
          minutesPerInterview: 0,
          isExpired: true,
          expiresAt: plan.expires_at
        }
      };
    }

    // Check remaining interviews for non-unlimited plans
    if (!isUnlimited && plan.interviews_remaining <= 0) {
      return {
        canStart: false,
        reason: `You've used all your interviews for this plan`,
        plan: {
          type: plan.plan_type,
          interviewsRemaining: 0,
          minutesPerInterview: plan.minutes_per_interview,
          isExpired: false,
          expiresAt: plan.expires_at
        }
      };
    }

    return {
      canStart: true,
      plan: {
        type: plan.plan_type,
        interviewsRemaining: isUnlimited ? -1 : plan.interviews_remaining,
        minutesPerInterview: plan.minutes_per_interview,
        isExpired: false,
        expiresAt: plan.expires_at
      }
    };
  } catch (error) {
    console.error('Error checking plan status:', error);
    return {
      canStart: false,
      reason: 'Unable to verify plan status',
      plan: {
        type: 'unknown',
        interviewsRemaining: 0,
        minutesPerInterview: 0,
        isExpired: false,
        expiresAt: null
      }
    };
  }
}

/**
 * Decrement the interview count for a user
 * @param {string} userId - The user ID
 * @returns {Promise<void>}
 */
async function decrementInterviewCount(userId) {
  try {
    const supabase = createSupabaseClient();
    
    // First, get the current plan to check the interviews_remaining count
    const { data: plan, error: fetchError } = await supabase
      .from('user_plans')
      .select('interviews_remaining')
      .eq('user_id', userId)
      .maybeSingle();
    
    if (fetchError) throw fetchError;
    
    // Don't decrement if plan doesn't exist or has unlimited interviews (-1)
    if (!plan || plan.interviews_remaining === -1) {
      console.log(`[Plan] Not decrementing interviews for user ${userId}: ${!plan ? 'no plan found' : 'unlimited plan'}`);
      return;
    }
    
    // Update with the decremented value
    const { error: updateError } = await supabase
      .from('user_plans')
      .update({
        interviews_remaining: plan.interviews_remaining - 1,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);
    
    if (updateError) throw updateError;
  } catch (error) {
    console.error('Error decrementing interview count:', error);
    throw error;
  }
}

module.exports = {
  getUserPlan,
  checkUserPlan,
  getPlanStatus,
  decrementInterviewCount
};