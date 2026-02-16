/**
 * SOLUS Telemetry Module
 *
 * Features:
 * - Announcements (fetch and display)
 * - Feedback submission
 * - Error reporting (automatic)
 * - Usage analytics
 */

const { app } = require('electron');
const os = require('os');

// =============================================
// CONFIGURATION
// =============================================
const SUPABASE_URL = 'https://lmbpctkoxxdhbmududzx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtYnBjdGtveHhkaGJtdWR1ZHp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0MzgyOTgsImV4cCI6MjA4NDAxNDI5OH0.idygxFnWQE6FDKOyU7MCFXfzZ5_meAyahuA4xcWjuzk';

// =============================================
// HELPERS
// =============================================

function getAppVersion() {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}

function getOsInfo() {
  return `${os.platform()} ${os.release()}`;
}

async function apiRequest(endpoint, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': options.prefer || 'return=representation'
  };

  console.log(`[Telemetry] ${options.method || 'GET'} ${endpoint}`);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    console.log(`[Telemetry] Response status: ${response.status}`);

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Telemetry] API Error: ${response.status} - ${error}`);
      throw new Error(`API Error: ${response.status} - ${error}`);
    }

    const text = await response.text();
    const result = text ? JSON.parse(text) : [];
    console.log(`[Telemetry] Success:`, result);
    return result;
  } catch (err) {
    console.error('[Telemetry] Request failed:', err.message);
    return null;
  }
}

// =============================================
// ANNOUNCEMENTS
// =============================================

/**
 * Fetch active announcements for current app version
 * @returns {Promise<Array>} List of announcements
 */
async function getAnnouncements() {
  try {
    const version = getAppVersion();
    const now = new Date().toISOString();

    // Fetch active announcements (simplified query for reliability)
    const announcements = await apiRequest(
      `announcements?is_active=eq.true&order=created_at.desc`
    );

    if (!announcements) return [];

    // Filter by expiry and version client-side
    return announcements.filter(a => {
      // Check expiry
      if (a.expires_at && new Date(a.expires_at) < new Date()) return false;
      // Check version range
      if (a.min_version && compareVersions(version, a.min_version) < 0) return false;
      if (a.max_version && compareVersions(version, a.max_version) > 0) return false;
      return true;
    });
  } catch (err) {
    console.error('Failed to fetch announcements:', err);
    return [];
  }
}

// Simple version comparison (1.2.3 format)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

// =============================================
// FEEDBACK
// =============================================

/**
 * Upload feedback image to Supabase Storage
 * @param {string} imageDataUrl - Base64 data URL of the image
 * @returns {Promise<string|null>} Public URL of uploaded image, or null on failure
 */
async function uploadFeedbackImage(imageDataUrl) {
  try {
    // Convert data URL to blob
    const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Generate unique filename
    const filename = `feedback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.png`;

    console.log(`[Telemetry] Uploading feedback image: ${filename}, size: ${buffer.length} bytes`);
    console.log(`[Telemetry] Image data URL prefix: ${imageDataUrl.substring(0, 50)}...`);

    // Upload to Supabase Storage
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/feedback-images/${filename}`;
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'image/png'
      },
      body: buffer
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Telemetry] Image upload failed: ${response.status} - ${error}`);
      return null;
    }

    // Return public URL
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/feedback-images/${filename}`;
    console.log(`[Telemetry] Image uploaded: ${publicUrl}`);
    return publicUrl;
  } catch (err) {
    console.error('[Telemetry] Image upload error:', err);
    return null;
  }
}

/**
 * Submit user feedback
 * @param {string} type - 'suggestion', 'bug', 'question', 'other'
 * @param {string} message - The feedback message
 * @param {string} contact - Optional contact info
 * @param {string} imageDataUrl - Optional base64 image data URL
 * @param {object} debugLogData - Optional debug log data for troubleshooting
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function submitFeedback(type, message, contact = null, imageDataUrl = null, debugLogData = null) {
  try {
    // Upload image first if provided
    let imageUrl = null;
    if (imageDataUrl) {
      imageUrl = await uploadFeedbackImage(imageDataUrl);
    }

    const result = await apiRequest('feedback', {
      method: 'POST',
      body: {
        type,
        message,
        contact,
        image_url: imageUrl,
        debug_log: debugLogData ? JSON.stringify(debugLogData) : null,
        app_version: getAppVersion(),
        os_info: getOsInfo()
      }
    });

    return { success: !!result };
  } catch (err) {
    console.error('Failed to submit feedback:', err);
    return { success: false, error: err.message };
  }
}

// =============================================
// ERROR REPORTING
// =============================================

/**
 * Report an error
 * @param {Error} error - The error object
 * @param {string} context - What the user was doing
 * @returns {Promise<void>}
 */
async function reportError(error, context = null) {
  try {
    await apiRequest('error_reports', {
      method: 'POST',
      body: {
        error_message: error.message || String(error),
        error_stack: error.stack || null,
        context,
        app_version: getAppVersion(),
        os_info: getOsInfo()
      }
    });
  } catch (err) {
    // Silently fail - don't want error reporting to cause more errors
    console.error('Failed to report error:', err);
  }
}

/**
 * Set up global error handlers
 */
function setupErrorHandlers() {
  // Catch unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    reportError(error, 'Unhandled Promise Rejection');
  });

  // Catch uncaught exceptions
  process.on('uncaughtException', (error) => {
    reportError(error, 'Uncaught Exception');
  });
}

// =============================================
// ANALYTICS
// =============================================

/**
 * Track an analytics event
 * @param {string} eventName - Name of the event
 * @param {object} eventData - Additional data
 * @returns {Promise<void>}
 */
async function trackEvent(eventName, eventData = null) {
  try {
    await apiRequest('events', {
      method: 'POST',
      body: {
        event_name: eventName,
        event_data: eventData,
        app_version: getAppVersion(),
        os_info: getOsInfo()
      }
    });
  } catch (err) {
    // Silently fail
    console.error('Failed to track event:', err);
  }
}

// Common events
const Events = {
  APP_OPEN: 'app_open',
  APP_CLOSE: 'app_close',
  FEATURE_USED: 'feature_used',
  IMPORT_STARTED: 'import_started',
  IMPORT_COMPLETED: 'import_completed',
  EXPORT_COMPLETED: 'export_completed',
  ERROR_OCCURRED: 'error_occurred'
};

// =============================================
// EXPORTS
// =============================================

module.exports = {
  // Announcements
  getAnnouncements,

  // Feedback
  submitFeedback,

  // Error reporting
  reportError,
  setupErrorHandlers,

  // Analytics
  trackEvent,
  Events
};
