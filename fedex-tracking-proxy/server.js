require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FEDEX_API_BASE = 'https://apis.fedex.com';

// OAuth2 token cache
let tokenCache = { token: null, expiresAt: 0 };

// API key auth middleware
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.PROXY_API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  next();
}

// Get FedEx OAuth2 access token (cached until expiry)
async function getFedExToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const response = await fetch(`${FEDEX_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.FEDEX_CLIENT_ID,
      client_secret: process.env.FEDEX_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FedEx OAuth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return tokenCache.token;
}

// Normalize FedEx status codes to standardized values
function normalizeStatus(statusDetail) {
  if (!statusDetail || !statusDetail.code) return { status: 'PENDING', description: 'Pending' };

  const code = statusDetail.code.toUpperCase();
  const desc = statusDetail.description || code;

  if (code === 'DL' || code === 'DELIVERED') return { status: 'DELIVERED', description: desc };
  if (code === 'OD' || code === 'OUT_FOR_DELIVERY') return { status: 'OUT_FOR_DELIVERY', description: desc };
  if (code === 'DE' || code === 'DELIVERY_EXCEPTION' || code.includes('EXCEPTION')) return { status: 'EXCEPTION', description: desc };
  if (code === 'IT' || code === 'IN_TRANSIT' || code === 'DP' || code === 'AR' || code === 'PU') return { status: 'IN_TRANSIT', description: desc };

  return { status: 'IN_TRANSIT', description: desc };
}

// Extract estimated delivery from FedEx dateAndTimes array
function getEstimatedDelivery(dateAndTimes) {
  if (!dateAndTimes || !Array.isArray(dateAndTimes)) return null;
  const etaEntry = dateAndTimes.find(d =>
    d.type === 'ESTIMATED_DELIVERY' || d.type === 'ACTUAL_DELIVERY' || d.type === 'APPOINTMENT_DELIVERY'
  );
  return etaEntry ? etaEntry.dateTime : null;
}

// Transform FedEx scan events to simplified format
function transformEvents(scanEvents) {
  if (!scanEvents || !Array.isArray(scanEvents)) return [];
  return scanEvents.slice(0, 20).map(event => ({
    timestamp: event.date,
    location: event.scanLocation
      ? [event.scanLocation.city, event.scanLocation.stateOrProvinceCode].filter(Boolean).join(', ')
      : null,
    description: event.eventDescription || event.eventType || 'Unknown event'
  }));
}

// Track a batch of up to 30 tracking numbers against FedEx API
async function trackBatch(numbers, token) {
  const trackingInfo = numbers.map(tn => ({
    trackingNumberInfo: { trackingNumber: tn }
  }));

  const response = await fetch(`${FEDEX_API_BASE}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-locale': 'en_US'
    },
    body: JSON.stringify({
      includeDetailedScans: true,
      trackingInfo
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FedEx Track API failed (${response.status}): ${text}`);
  }

  const result = await response.json();
  const output = result.output || {};
  const packages = output.completeTrackResults || [];

  // Build a set of tracking numbers that got real responses
  const responseMap = new Map();

  packages.forEach(pkg => {
    const trackResult = (pkg.trackResults && pkg.trackResults[0]) || {};
    const statusDetail = trackResult.latestStatusDetail || {};
    // Check if FedEx returned an error for this specific tracking number
    const hasError = trackResult.error || (trackResult.notifications &&
      trackResult.notifications.some(n => n.severity === 'ERROR'));
    const errorMsg = hasError
      ? (trackResult.error?.message || trackResult.notifications?.find(n => n.severity === 'ERROR')?.message || 'Unknown error')
      : null;

    if (hasError || !statusDetail.code) {
      responseMap.set(pkg.trackingNumber, {
        trackingNumber: pkg.trackingNumber,
        status: 'ERROR',
        statusDescription: errorMsg || 'No tracking data available',
        estimatedDelivery: null,
        lastLocation: null,
        events: []
      });
    } else {
      const normalized = normalizeStatus(statusDetail);
      const eta = getEstimatedDelivery(trackResult.dateAndTimes);
      const events = transformEvents(trackResult.scanEvents);
      const lastEvent = events[0] || null;

      responseMap.set(pkg.trackingNumber, {
        trackingNumber: pkg.trackingNumber,
        status: normalized.status,
        statusDescription: normalized.description,
        estimatedDelivery: eta,
        lastLocation: lastEvent ? lastEvent.location : null,
        events
      });
    }
  });

  // Ensure ALL requested numbers have a response entry
  const data = numbers.map(tn => {
    if (responseMap.has(tn)) return responseMap.get(tn);
    return {
      trackingNumber: tn,
      status: 'ERROR',
      statusDescription: 'No response from FedEx',
      estimatedDelivery: null,
      lastLocation: null,
      events: []
    };
  });

  return data;
}

// Main tracking endpoint
app.post('/api/track', authenticate, async (req, res) => {
  try {
    const { trackingNumbers } = req.body;
    if (!trackingNumbers || !Array.isArray(trackingNumbers) || trackingNumbers.length === 0) {
      return res.status(400).json({ success: false, error: 'trackingNumbers array required' });
    }

    const token = await getFedExToken();

    // Batch into groups of 30 (FedEx API limit)
    const allData = [];
    for (let i = 0; i < trackingNumbers.length; i += 30) {
      const batch = trackingNumbers.slice(i, i + 30);
      const batchData = await trackBatch(batch, token);
      allData.push(...batchData);
    }

    res.json({ success: true, data: allData });
  } catch (error) {
    console.error('[TRACK ERROR]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'fedex-tracking-proxy' });
});

app.listen(PORT, () => {
  console.log(`FedEx tracking proxy running on port ${PORT}`);
});
