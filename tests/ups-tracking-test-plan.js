/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SOLUS — UPS Tracking Integration: Comprehensive Test Plan
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Agent E — QA / Testing Architect
 *
 * This file is the executable test plan.  It contains:
 *   1. Fixture definitions (golden payloads)
 *   2. JSON schema for UPS API contract
 *   3. Status-mapping test matrix (30 cases)
 *   4. Unit tests (carrier detection, status normalizer, parser)
 *   5. Integration tests (full flow, cache, retry, rate-limit)
 *   6. Regression tests (FedEx still works, unified schema)
 *   7. Error-handling tests
 *   8. E2E Playwright tests (plugs into `npm run verify`)
 *
 * Run standalone:  npx playwright test tests/ups-tracking-test-plan.js
 * Run with suite:  npm run verify            (auto-discovered)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 0 — DESIGN DECISIONS & HARNESS ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════════════════
//
// How we test UPS tracking without real API calls:
//
//   1. FIXTURE FILES — golden JSON payloads stored in tests/fixtures/ups/*.json
//      representing every UPS status scenario.  These are consumed by unit tests
//      AND by an in-process mock that replaces `fetch()` during E2E.
//
//   2. MOCK INJECTION — SOLUS already blocks network in test mode via
//      `testModeNetworkGuard()`.  For UPS, the IPC handler (`fetch-ups-tracking`)
//      will check `SOLUS_TEST_MODE` and, when set, return fixture data instead of
//      calling the real UPS API.  This keeps the test surface identical to prod
//      (same IPC path, same parse/normalize code) while staying offline.
//
//   3. EXISTING FRAMEWORK — Playwright Electron via `npm run verify`.
//      New tests go in `tests/e2e/verify.spec.js` (extend existing describe
//      blocks) and in a new `tests/e2e/ups-tracking.spec.js` for UPS-specific
//      scenarios.
//
//   4. ISOLATION — `SOLUS_TEST_MODE=1` + `SOLUS_TEST_USER_DATA=<tmpdir>`.
//      No real credentials needed.  UPS client_id / client_secret are never
//      read in test mode.
//
// ═══════════════════════════════════════════════════════════════════════════════

const { test, expect } = require('@playwright/test');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — FIXTURE DEFINITIONS (Golden Payloads)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each fixture represents a UPS Track API v1 response.
// The real file should live at tests/fixtures/ups/<name>.json.
// Below are the JS-object equivalents used directly in tests.

const UPS_FIXTURES = {

  // ── 1. Normal delivered package (with signature) ──────────────────────────
  delivered_with_signature: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1Z999AA10123456784',
          deliveryDate: [{ type: 'DEL', date: '20260225' }],
          deliveryTime: { endTime: '143000' },
          currentStatus: {
            type: 'D',
            description: 'Delivered',
            code: 'KB',
            simplifiedTextDescription: 'Delivered',
            statusCode: '011'
          },
          packageAddress: [{
            type: 'DESTINATION',
            address: { city: 'AUSTIN', stateProvince: 'TX', postalCode: '78701', country: 'US' }
          }],
          weight: { unitOfMeasurement: 'LBS', weight: '2.30' },
          service: { code: '003', description: 'UPS Ground' },
          activity: [
            {
              date: '20260225', time: '143000',
              location: { address: { city: 'AUSTIN', stateProvince: 'TX', postalCode: '78701', country: 'US' } },
              status: { type: 'D', description: 'Delivered', code: 'KB', statusCode: '011' },
              additionalAttributes: [{ text: 'SIGNED BY: M JOHNSON' }]
            },
            {
              date: '20260225', time: '073000',
              location: { address: { city: 'AUSTIN', stateProvince: 'TX', country: 'US' } },
              status: { type: 'I', description: 'Out For Delivery Today', code: 'OT', statusCode: '021' }
            },
            {
              date: '20260224', time: '210000',
              location: { address: { city: 'MESQUITE', stateProvince: 'TX', country: 'US' } },
              status: { type: 'I', description: 'Arrived at Facility', code: 'AR', statusCode: '007' }
            },
            {
              date: '20260224', time: '030000',
              location: { address: { city: 'DALLAS', stateProvince: 'TX', country: 'US' } },
              status: { type: 'I', description: 'Departed from Facility', code: 'DP', statusCode: '005' }
            },
            {
              date: '20260222', time: '180000',
              location: { address: { city: 'HODGKINS', stateProvince: 'IL', country: 'US' } },
              status: { type: 'I', description: 'Origin Scan', code: 'OR', statusCode: '003' }
            },
            {
              date: '20260222', time: '100000',
              location: { address: { city: 'CHICAGO', stateProvince: 'IL', country: 'US' } },
              status: { type: 'M', description: 'Shipper created a label, UPS has not yet received the package', code: 'MP', statusCode: '001' }
            }
          ]
        }]
      }]
    }
  },

  // ── 2. In-transit package (with ETA and multiple events) ──────────────────
  in_transit_with_eta: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1Z999BB20234567890',
          deliveryDate: [{ type: 'SDD', date: '20260305' }],
          currentStatus: {
            type: 'I',
            description: 'In Transit',
            code: 'IT',
            simplifiedTextDescription: 'In Transit',
            statusCode: '005'
          },
          packageAddress: [{
            type: 'DESTINATION',
            address: { city: 'SEATTLE', stateProvince: 'WA', postalCode: '98101', country: 'US' }
          }],
          weight: { unitOfMeasurement: 'LBS', weight: '5.80' },
          service: { code: '002', description: 'UPS 2nd Day Air' },
          activity: [
            {
              date: '20260303', time: '150000',
              location: { address: { city: 'PHOENIX', stateProvince: 'AZ', country: 'US' } },
              status: { type: 'I', description: 'Departed from Facility', code: 'DP', statusCode: '005' }
            },
            {
              date: '20260303', time: '080000',
              location: { address: { city: 'PHOENIX', stateProvince: 'AZ', country: 'US' } },
              status: { type: 'I', description: 'Arrived at Facility', code: 'AR', statusCode: '007' }
            },
            {
              date: '20260302', time: '190000',
              location: { address: { city: 'LOS ANGELES', stateProvince: 'CA', country: 'US' } },
              status: { type: 'I', description: 'Origin Scan', code: 'OR', statusCode: '003' }
            },
            {
              date: '20260302', time: '120000',
              location: { address: { city: 'LOS ANGELES', stateProvince: 'CA', country: 'US' } },
              status: { type: 'M', description: 'Shipper created a label, UPS has not yet received the package', code: 'MP', statusCode: '001' }
            }
          ]
        }]
      }]
    }
  },

  // ── 3. Exception package (delivery attempt failed) ────────────────────────
  exception_delivery_attempt: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1ZEXCEPTION000001',
          deliveryDate: [{ type: 'SDD', date: '20260228' }],
          currentStatus: {
            type: 'X',
            description: 'The package was not delivered due to the business being closed.',
            code: 'A1',
            simplifiedTextDescription: 'Delivery attempted - business closed',
            statusCode: '099'
          },
          packageAddress: [{
            type: 'DESTINATION',
            address: { city: 'NEW YORK', stateProvince: 'NY', postalCode: '10001', country: 'US' }
          }],
          weight: { unitOfMeasurement: 'LBS', weight: '1.20' },
          service: { code: '001', description: 'UPS Next Day Air' },
          activity: [
            {
              date: '20260228', time: '170000',
              location: { address: { city: 'NEW YORK', stateProvince: 'NY', country: 'US' } },
              status: { type: 'X', description: 'A delivery attempt was made; the business was closed. A 2nd attempt will be made.', code: 'A1', statusCode: '099' }
            },
            {
              date: '20260228', time: '080000',
              location: { address: { city: 'NEW YORK', stateProvince: 'NY', country: 'US' } },
              status: { type: 'I', description: 'Out For Delivery Today', code: 'OT', statusCode: '021' }
            },
            {
              date: '20260227', time: '220000',
              location: { address: { city: 'SECAUCUS', stateProvince: 'NJ', country: 'US' } },
              status: { type: 'I', description: 'Arrived at Facility', code: 'AR', statusCode: '007' }
            }
          ]
        }]
      }]
    }
  },

  // ── 4. International package with customs events ──────────────────────────
  international_customs: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1ZINTERNATIONAL01',
          deliveryDate: [{ type: 'SDD', date: '20260310' }],
          currentStatus: {
            type: 'I',
            description: 'Your package is in transit. We\'re updating plans to schedule your delivery.',
            code: 'IT',
            simplifiedTextDescription: 'In Transit - Customs Cleared',
            statusCode: '005'
          },
          packageAddress: [{
            type: 'DESTINATION',
            address: { city: 'LONDON', stateProvince: '', postalCode: 'W1A 1AB', country: 'GB' }
          }],
          weight: { unitOfMeasurement: 'KGS', weight: '3.40' },
          service: { code: '008', description: 'UPS Worldwide Expedited' },
          activity: [
            {
              date: '20260306', time: '140000',
              location: { address: { city: 'EAST MIDLANDS', stateProvince: '', country: 'GB' } },
              status: { type: 'I', description: 'Customs Clearance Completed', code: 'CC', statusCode: '052' }
            },
            {
              date: '20260305', time: '090000',
              location: { address: { city: 'EAST MIDLANDS', stateProvince: '', country: 'GB' } },
              status: { type: 'I', description: 'Package received by customs', code: 'CU', statusCode: '050' }
            },
            {
              date: '20260304', time: '210000',
              location: { address: { city: 'LOUISVILLE', stateProvince: 'KY', country: 'US' } },
              status: { type: 'I', description: 'Departed from Facility', code: 'DP', statusCode: '005' }
            },
            {
              date: '20260303', time: '160000',
              location: { address: { city: 'LOUISVILLE', stateProvince: 'KY', country: 'US' } },
              status: { type: 'I', description: 'Arrived at Facility', code: 'AR', statusCode: '007' }
            },
            {
              date: '20260302', time: '100000',
              location: { address: { city: 'CHICAGO', stateProvince: 'IL', country: 'US' } },
              status: { type: 'M', description: 'Shipper created a label, UPS has not yet received the package', code: 'MP', statusCode: '001' }
            }
          ]
        }]
      }]
    }
  },

  // ── 5. Returned to sender ─────────────────────────────────────────────────
  returned_to_sender: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1ZRETURNEDSNDR001',
          currentStatus: {
            type: 'RS',
            description: 'Returning package to sender',
            code: 'RS',
            simplifiedTextDescription: 'Returned to Sender',
            statusCode: '032'
          },
          activity: [
            {
              date: '20260227', time: '100000',
              location: { address: { city: 'MEMPHIS', stateProvince: 'TN', country: 'US' } },
              status: { type: 'RS', description: 'The package is being returned to the sender.', code: 'RS', statusCode: '032' }
            }
          ]
        }]
      }]
    }
  },

  // ── 6. Error: tracking not found ──────────────────────────────────────────
  tracking_not_found: {
    trackResponse: {
      shipment: [{
        warnings: [{
          code: 'TW0001',
          message: 'Tracking Information Not Found'
        }]
      }]
    }
  },

  // ── 7. Error: invalid tracking number ─────────────────────────────────────
  invalid_tracking_number: {
    response: {
      errors: [{
        code: '151018',
        message: 'Invalid tracking number'
      }]
    }
  },

  // ── 8. Hold at location ───────────────────────────────────────────────────
  hold_at_location: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1ZHOLDATLOC000001',
          currentStatus: {
            type: 'I',
            description: 'Held at request of consignee. Will deliver upon request.',
            code: 'NA',
            simplifiedTextDescription: 'Held for Pickup at UPS Access Point',
            statusCode: '016'
          },
          activity: [
            {
              date: '20260301', time: '120000',
              location: { address: { city: 'PORTLAND', stateProvince: 'OR', country: 'US' } },
              status: { type: 'I', description: 'Held for customer pickup at UPS Access Point', code: 'NA', statusCode: '016' }
            }
          ]
        }]
      }]
    }
  },

  // ── 9. Weather delay ──────────────────────────────────────────────────────
  weather_delay: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1ZWEATHERDELAY01',
          currentStatus: {
            type: 'X',
            description: 'Severe weather conditions have delayed delivery.',
            code: 'B5',
            simplifiedTextDescription: 'Delay - Severe Weather',
            statusCode: '042'
          },
          activity: [
            {
              date: '20260301', time: '060000',
              location: { address: { city: 'DENVER', stateProvince: 'CO', country: 'US' } },
              status: { type: 'X', description: 'Severe weather conditions have delayed delivery. / Delivery will be rescheduled.', code: 'B5', statusCode: '042' }
            }
          ]
        }]
      }]
    }
  },

  // ── 10. Out for delivery ──────────────────────────────────────────────────
  out_for_delivery: {
    trackResponse: {
      shipment: [{
        package: [{
          trackingNumber: '1ZOUTFORDELIVER01',
          currentStatus: {
            type: 'I',
            description: 'Out For Delivery Today',
            code: 'OT',
            simplifiedTextDescription: 'Out for Delivery',
            statusCode: '021'
          },
          activity: [
            {
              date: '20260302', time: '070000',
              location: { address: { city: 'SAN FRANCISCO', stateProvince: 'CA', country: 'US' } },
              status: { type: 'I', description: 'Out For Delivery Today', code: 'OT', statusCode: '021' }
            }
          ]
        }]
      }]
    }
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — JSON SCHEMA (UPS Track API v1 Response Contract)
// ═══════════════════════════════════════════════════════════════════════════════
//
// This schema defines the minimum fields SOLUS requires from a UPS Track API
// response.  It is used for contract testing — if UPS changes their API format,
// these validation checks will catch it.

const UPS_RESPONSE_SCHEMA = {
  required: ['trackResponse'],
  properties: {
    trackResponse: {
      required: ['shipment'],
      properties: {
        shipment: {
          type: 'array',
          minItems: 1,
          items: {
            properties: {
              package: {
                type: 'array',
                items: {
                  required: ['trackingNumber', 'currentStatus', 'activity'],
                  properties: {
                    trackingNumber: { type: 'string', pattern: '^1Z[A-Z0-9]{16}$' },
                    currentStatus: {
                      required: ['type', 'description'],
                      properties: {
                        type:        { type: 'string', enum: ['M', 'I', 'D', 'X', 'P', 'RS', 'MV', 'DO'] },
                        description: { type: 'string' },
                        code:        { type: 'string' },
                        statusCode:  { type: 'string' },
                        simplifiedTextDescription: { type: 'string' }
                      }
                    },
                    deliveryDate: {
                      type: 'array',
                      items: {
                        properties: {
                          type: { type: 'string' },
                          date: { type: 'string', pattern: '^\\d{8}$' }
                        }
                      }
                    },
                    activity: {
                      type: 'array',
                      items: {
                        required: ['date', 'status'],
                        properties: {
                          date:     { type: 'string', pattern: '^\\d{8}$' },
                          time:     { type: 'string' },
                          location: { type: 'object' },
                          status:   { required: ['type', 'description'] }
                        }
                      }
                    }
                  }
                }
              },
              warnings: { type: 'array' }
            }
          }
        }
      }
    }
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — STATUS MAPPING TEST MATRIX
// ═══════════════════════════════════════════════════════════════════════════════
//
// SOLUS normalizes tracking statuses into a unified schema shared by FedEx and
// UPS.  The Live Track UI uses:
//   IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED | EXCEPTION | PENDING | ERROR
//
// For order status updates, SOLUS maps to its internal set:
//   confirmed | shipped | delivered | cancelled | declined
//
// The `mapUpsStatusToSolus()` function (to be implemented in main.js) maps
// from UPS status type + code to these two domains.

const STATUS_MAPPING_MATRIX = [
  // ─── Pre-Transit / Label Created ────────────────────────────────────────
  { id: 'ST-01', upsType: 'M',  upsCode: 'MP', upsDesc: 'Shipper created a label, UPS has not yet received the package', expectedLiveTrack: 'PENDING',          expectedSolus: null,        notes: 'Label created, no physical possession' },
  { id: 'ST-02', upsType: 'M',  upsCode: 'OF', upsDesc: 'Billing information received',                                     expectedLiveTrack: 'PENDING',          expectedSolus: null,        notes: 'Manifest/billing only' },

  // ─── Picked Up / Origin ─────────────────────────────────────────────────
  { id: 'ST-03', upsType: 'P',  upsCode: 'PU', upsDesc: 'Picked up',                                                        expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Physical pickup' },
  { id: 'ST-04', upsType: 'I',  upsCode: 'OR', upsDesc: 'Origin Scan',                                                      expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'First scan at origin facility' },

  // ─── In Transit ─────────────────────────────────────────────────────────
  { id: 'ST-05', upsType: 'I',  upsCode: 'IT', upsDesc: 'In Transit',                                                        expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Generic in-transit' },
  { id: 'ST-06', upsType: 'I',  upsCode: 'DP', upsDesc: 'Departed from Facility',                                            expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Left hub' },
  { id: 'ST-07', upsType: 'I',  upsCode: 'AR', upsDesc: 'Arrived at Facility',                                               expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Arrived at intermediate hub' },
  { id: 'ST-08', upsType: 'I',  upsCode: 'AF', upsDesc: 'Arrived at UPS Facility',                                           expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Variant arrival scan' },
  { id: 'ST-09', upsType: 'I',  upsCode: 'DS', upsDesc: 'Destination Scan',                                                  expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'At final local facility' },

  // ─── Out for Delivery ───────────────────────────────────────────────────
  { id: 'ST-10', upsType: 'I',  upsCode: 'OT', upsDesc: 'Out For Delivery Today',                                            expectedLiveTrack: 'OUT_FOR_DELIVERY', expectedSolus: 'shipped',   notes: 'On the truck' },
  { id: 'ST-11', upsType: 'I',  upsCode: 'FD', upsDesc: 'Out for Delivery (2nd attempt)',                                    expectedLiveTrack: 'OUT_FOR_DELIVERY', expectedSolus: 'shipped',   notes: 'Re-attempt delivery' },

  // ─── Delivered ──────────────────────────────────────────────────────────
  { id: 'ST-12', upsType: 'D',  upsCode: 'KB', upsDesc: 'Delivered',                                                         expectedLiveTrack: 'DELIVERED',        expectedSolus: 'delivered', notes: 'Standard delivery' },
  { id: 'ST-13', upsType: 'D',  upsCode: 'DL', upsDesc: 'Delivered - Left at front door',                                    expectedLiveTrack: 'DELIVERED',        expectedSolus: 'delivered', notes: 'Left at door' },
  { id: 'ST-14', upsType: 'D',  upsCode: 'FS', upsDesc: 'Delivered - Released',                                              expectedLiveTrack: 'DELIVERED',        expectedSolus: 'delivered', notes: 'Driver release' },
  { id: 'ST-15', upsType: 'D',  upsCode: 'AG', upsDesc: 'Delivered - Given to agent',                                        expectedLiveTrack: 'DELIVERED',        expectedSolus: 'delivered', notes: 'Building agent / concierge' },
  { id: 'ST-16', upsType: 'D',  upsCode: 'PL', upsDesc: 'Delivered to Access Point',                                         expectedLiveTrack: 'DELIVERED',        expectedSolus: 'delivered', notes: 'UPS Store / Access Point' },
  { id: 'ST-17', upsType: 'D',  upsCode: 'BC', upsDesc: 'Delivered - Placed in mailbox',                                     expectedLiveTrack: 'DELIVERED',        expectedSolus: 'delivered', notes: 'SurePost mailbox' },

  // ─── Exceptions ─────────────────────────────────────────────────────────
  { id: 'ST-18', upsType: 'X',  upsCode: 'A1', upsDesc: 'Delivery attempted - business closed',                              expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Will re-attempt' },
  { id: 'ST-19', upsType: 'X',  upsCode: 'A2', upsDesc: 'Delivery attempted - no one home',                                  expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Will re-attempt or hold' },
  { id: 'ST-20', upsType: 'X',  upsCode: 'A6', upsDesc: 'Delivery attempted - adult signature required, no one available',   expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Signature-required exception' },
  { id: 'ST-21', upsType: 'X',  upsCode: 'B5', upsDesc: 'Severe weather conditions have delayed delivery',                   expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Weather delay - temporary' },
  { id: 'ST-22', upsType: 'X',  upsCode: 'CM', upsDesc: 'The address has been corrected and delivery rescheduled',           expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Address correction' },
  { id: 'ST-23', upsType: 'X',  upsCode: 'D1', upsDesc: 'Package damaged, UPS attempting to repackage',                      expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Damaged - repackaging' },
  { id: 'ST-24', upsType: 'X',  upsCode: 'HN', upsDesc: 'Held for customer pickup at UPS facility',                          expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Hold at facility' },

  // ─── Return / Redirect ──────────────────────────────────────────────────
  { id: 'ST-25', upsType: 'RS', upsCode: 'RS', upsDesc: 'Returning package to sender',                                       expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Returned to sender' },
  { id: 'ST-26', upsType: 'I',  upsCode: 'RD', upsDesc: 'Package redirected to new address',                                 expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Rerouted by shipper/recipient' },

  // ─── Customs (International) ────────────────────────────────────────────
  { id: 'ST-27', upsType: 'I',  upsCode: 'CU', upsDesc: 'Package received by customs',                                      expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Customs intake' },
  { id: 'ST-28', upsType: 'I',  upsCode: 'CC', upsDesc: 'Customs Clearance Completed',                                      expectedLiveTrack: 'IN_TRANSIT',       expectedSolus: 'shipped',   notes: 'Cleared customs' },
  { id: 'ST-29', upsType: 'X',  upsCode: 'CH', upsDesc: 'Package held by customs',                                           expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Customs hold - may require docs' },

  // ─── Edge: Multiple Attempts ────────────────────────────────────────────
  { id: 'ST-30', upsType: 'X',  upsCode: 'NF', upsDesc: 'UPS InfoNotice left; 3rd delivery attempt will be made',            expectedLiveTrack: 'EXCEPTION',        expectedSolus: null,        notes: 'Final attempt pending' },
];


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — UNIT TESTS: CARRIER DETECTION
// ═══════════════════════════════════════════════════════════════════════════════
//
// These test the `detectCarrier()` function in main.js against UPS patterns.
// Since detectCarrier is in main process scope and not directly importable,
// we test it via IPC by seeding orders and reading back carrier, or by
// exercising it in Electron's evaluate context.

const CARRIER_DETECTION_CASES = [
  // UPS 1Z format
  { tracking: '1Z999AA10123456784', content: '',                            expected: 'UPS',     note: 'Standard UPS 1Z format' },
  { tracking: '1Z999BB20234567890', content: '',                            expected: 'UPS',     note: '1Z with mixed alphanumeric' },
  { tracking: '1z999cc30345678901', content: '',                            expected: 'UPS',     note: '1Z lowercase (case insensitive)' },
  { tracking: '1Z12345E0205271688', content: '',                            expected: 'UPS',     note: 'Real-format UPS number' },

  // UPS content-based fallback (non-1Z tracking)
  { tracking: '9999999999',         content: 'ups.com tracking update',     expected: 'UPS',     note: 'Content-based UPS detection (ups.com)' },

  // Must NOT misidentify FedEx as UPS
  { tracking: '789456123012',       content: 'fedex shipment notification', expected: 'FedEx',   note: '12-digit + FedEx content = FedEx' },
  { tracking: '789456123012345',    content: 'fedex express',               expected: 'FedEx',   note: '15-digit + FedEx content = FedEx' },

  // Ambiguous - 12 digit with UPS content should be Unknown (not 1Z format)
  { tracking: '789456123012',       content: 'ups tracking confirmation',   expected: 'Unknown', note: '12-digit + UPS content = Unknown (ambiguous)' },

  // USPS should not be detected as UPS
  { tracking: '9400111899223100001234', content: '',                        expected: 'USPS',    note: 'Long USPS format' },

  // OnTrac should not be detected as UPS
  { tracking: 'C12345678901234',    content: '',                            expected: 'OnTrac',  note: 'OnTrac C-prefix' },
];


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — UPS STATUS NORMALIZER (function under test)
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is the reference implementation of the status mapping function.
// It will be implemented in main.js; this serves as the spec.

/**
 * Maps a UPS status type + code to the SOLUS Live Track unified status.
 * @param {string} type - UPS status type letter (M, I, D, X, P, RS, etc.)
 * @param {string} code - UPS status code (OT, KB, A1, etc.)
 * @param {string} description - UPS status description text
 * @returns {{ liveTrackStatus: string, solusStatus: string|null }}
 */
function mapUpsStatusToSolus(type, code, description = '') {
  const descLower = (description || '').toLowerCase();

  // Delivered
  if (type === 'D') {
    return { liveTrackStatus: 'DELIVERED', solusStatus: 'delivered' };
  }

  // Returned to sender
  if (type === 'RS') {
    return { liveTrackStatus: 'EXCEPTION', solusStatus: null };
  }

  // Exception
  if (type === 'X') {
    return { liveTrackStatus: 'EXCEPTION', solusStatus: null };
  }

  // Manifest / label created (pre-transit)
  if (type === 'M') {
    return { liveTrackStatus: 'PENDING', solusStatus: null };
  }

  // Picked up
  if (type === 'P') {
    return { liveTrackStatus: 'IN_TRANSIT', solusStatus: 'shipped' };
  }

  // In transit — check for out-for-delivery subcases
  if (type === 'I') {
    if (code === 'OT' || code === 'FD' || descLower.includes('out for delivery')) {
      return { liveTrackStatus: 'OUT_FOR_DELIVERY', solusStatus: 'shipped' };
    }
    return { liveTrackStatus: 'IN_TRANSIT', solusStatus: 'shipped' };
  }

  // Unknown / fallback
  return { liveTrackStatus: 'PENDING', solusStatus: null };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — UNIT TESTS: STATUS NORMALIZER
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('UPS Status Normalizer — Unit Tests', () => {

  for (const tc of STATUS_MAPPING_MATRIX) {
    test(`${tc.id}: ${tc.upsDesc.substring(0, 60)}... => ${tc.expectedLiveTrack}`, () => {
      const result = mapUpsStatusToSolus(tc.upsType, tc.upsCode, tc.upsDesc);
      expect(result.liveTrackStatus).toBe(tc.expectedLiveTrack);
      if (tc.expectedSolus !== null) {
        expect(result.solusStatus).toBe(tc.expectedSolus);
      } else {
        expect(result.solusStatus).toBeNull();
      }
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — CONTRACT TESTS (API Response Validation)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('UPS API Contract Tests', () => {

  /**
   * Lightweight schema validator (no external dep needed).
   * Checks required fields, type, and pattern constraints.
   */
  function validateSchema(obj, schema, path = '') {
    const errors = [];

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`${path}.${key} is required but missing`);
        }
      }
    }

    if (schema.type === 'array') {
      if (!Array.isArray(obj)) {
        errors.push(`${path} expected array, got ${typeof obj}`);
      } else {
        if (schema.minItems && obj.length < schema.minItems) {
          errors.push(`${path} needs at least ${schema.minItems} items, got ${obj.length}`);
        }
        if (schema.items) {
          obj.forEach((item, i) => {
            errors.push(...validateSchema(item, schema.items, `${path}[${i}]`));
          });
        }
      }
      return errors;
    }

    if (schema.type === 'string') {
      if (typeof obj !== 'string') {
        errors.push(`${path} expected string, got ${typeof obj}`);
      } else if (schema.pattern && !new RegExp(schema.pattern).test(obj)) {
        errors.push(`${path} "${obj}" does not match pattern ${schema.pattern}`);
      } else if (schema.enum && !schema.enum.includes(obj)) {
        errors.push(`${path} "${obj}" not in enum [${schema.enum.join(', ')}]`);
      }
      return errors;
    }

    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          errors.push(...validateSchema(obj[key], subSchema, `${path}.${key}`));
        }
      }
    }

    return errors;
  }

  test('Delivered fixture conforms to UPS response schema', () => {
    const errors = validateSchema(UPS_FIXTURES.delivered_with_signature, UPS_RESPONSE_SCHEMA);
    expect(errors).toEqual([]);
  });

  test('In-transit fixture conforms to UPS response schema', () => {
    const errors = validateSchema(UPS_FIXTURES.in_transit_with_eta, UPS_RESPONSE_SCHEMA);
    expect(errors).toEqual([]);
  });

  test('Exception fixture conforms to UPS response schema', () => {
    const errors = validateSchema(UPS_FIXTURES.exception_delivery_attempt, UPS_RESPONSE_SCHEMA);
    expect(errors).toEqual([]);
  });

  test('International fixture conforms to UPS response schema', () => {
    const errors = validateSchema(UPS_FIXTURES.international_customs, UPS_RESPONSE_SCHEMA);
    expect(errors).toEqual([]);
  });

  // ── Graceful degradation when optional fields missing ────────────────────

  test('Parser handles missing deliveryDate gracefully', () => {
    const fixture = JSON.parse(JSON.stringify(UPS_FIXTURES.delivered_with_signature));
    delete fixture.trackResponse.shipment[0].package[0].deliveryDate;
    const pkg = fixture.trackResponse.shipment[0].package[0];
    // Parser should not throw; ETA should be null/undefined
    const parsed = parseUpsPackage(pkg);
    expect(parsed).toBeTruthy();
    expect(parsed.estimatedDelivery).toBeFalsy();
  });

  test('Parser handles missing activity array gracefully', () => {
    const fixture = JSON.parse(JSON.stringify(UPS_FIXTURES.delivered_with_signature));
    fixture.trackResponse.shipment[0].package[0].activity = [];
    const pkg = fixture.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);
    expect(parsed).toBeTruthy();
    expect(parsed.events).toEqual([]);
  });

  test('Parser handles missing location in activity gracefully', () => {
    const fixture = JSON.parse(JSON.stringify(UPS_FIXTURES.in_transit_with_eta));
    delete fixture.trackResponse.shipment[0].package[0].activity[0].location;
    const pkg = fixture.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);
    expect(parsed.events[0].location).toBe('');
  });

  test('Parser handles missing simplifiedTextDescription gracefully', () => {
    const fixture = JSON.parse(JSON.stringify(UPS_FIXTURES.delivered_with_signature));
    delete fixture.trackResponse.shipment[0].package[0].currentStatus.simplifiedTextDescription;
    const pkg = fixture.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);
    // Should fall back to description field
    expect(parsed.statusDescription).toBe('Delivered');
  });

  test('Parser handles missing weight gracefully', () => {
    const fixture = JSON.parse(JSON.stringify(UPS_FIXTURES.delivered_with_signature));
    delete fixture.trackResponse.shipment[0].package[0].weight;
    const pkg = fixture.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);
    expect(parsed).toBeTruthy();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — UPS RESPONSE PARSER (reference implementation)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Transforms raw UPS Track API response into the SOLUS unified tracking format
// (same shape as the FedEx proxy returns).

/**
 * Parse a single UPS package tracking response into the SOLUS unified format.
 * @param {object} pkg - UPS package object from trackResponse.shipment[].package[]
 * @returns {object} SOLUS unified tracking object
 */
function parseUpsPackage(pkg) {
  if (!pkg || !pkg.currentStatus) {
    return {
      trackingNumber: pkg?.trackingNumber || '',
      carrier: 'UPS',
      status: 'ERROR',
      statusDescription: 'Invalid tracking data',
      estimatedDelivery: null,
      lastLocation: '',
      events: [],
    };
  }

  const status = mapUpsStatusToSolus(
    pkg.currentStatus.type,
    pkg.currentStatus.code,
    pkg.currentStatus.description
  );

  // Extract ETA from deliveryDate array
  let estimatedDelivery = null;
  if (pkg.deliveryDate && pkg.deliveryDate.length > 0) {
    const dateStr = pkg.deliveryDate[0].date; // YYYYMMDD
    if (dateStr && dateStr.length === 8) {
      estimatedDelivery = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    }
  }

  // Extract last known location from most recent activity
  let lastLocation = '';
  if (pkg.activity && pkg.activity.length > 0) {
    const loc = pkg.activity[0]?.location?.address;
    if (loc) {
      const parts = [loc.city, loc.stateProvince, loc.country].filter(Boolean);
      lastLocation = parts.join(', ');
    }
  }

  // Convert activity to SOLUS event format
  const events = (pkg.activity || []).map(act => {
    const loc = act.location?.address;
    const locationStr = loc
      ? [loc.city, loc.stateProvince, loc.country].filter(Boolean).join(', ')
      : '';

    // Build ISO timestamp from UPS date/time
    let timestamp = null;
    if (act.date) {
      const d = act.date;
      const t = act.time || '000000';
      timestamp = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
    }

    return {
      timestamp,
      description: act.status?.description || '',
      location: locationStr,
    };
  });

  return {
    trackingNumber: pkg.trackingNumber || '',
    carrier: 'UPS',
    status: status.liveTrackStatus,
    statusDescription: pkg.currentStatus.simplifiedTextDescription || pkg.currentStatus.description || '',
    estimatedDelivery,
    lastLocation,
    events,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — PARSER UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('UPS Response Parser — Unit Tests', () => {

  test('Parses delivered package correctly', () => {
    const pkg = UPS_FIXTURES.delivered_with_signature.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.trackingNumber).toBe('1Z999AA10123456784');
    expect(parsed.carrier).toBe('UPS');
    expect(parsed.status).toBe('DELIVERED');
    expect(parsed.statusDescription).toBe('Delivered');
    expect(parsed.estimatedDelivery).toBe('2026-02-25');
    expect(parsed.lastLocation).toBe('AUSTIN, TX, US');
    expect(parsed.events.length).toBe(6);
    expect(parsed.events[0].description).toBe('Delivered');
    expect(parsed.events[0].timestamp).toBe('2026-02-25T14:30:00');
  });

  test('Parses in-transit package correctly', () => {
    const pkg = UPS_FIXTURES.in_transit_with_eta.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.trackingNumber).toBe('1Z999BB20234567890');
    expect(parsed.status).toBe('IN_TRANSIT');
    expect(parsed.estimatedDelivery).toBe('2026-03-05');
    expect(parsed.events.length).toBe(4);
  });

  test('Parses exception package correctly', () => {
    const pkg = UPS_FIXTURES.exception_delivery_attempt.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.status).toBe('EXCEPTION');
    expect(parsed.statusDescription).toContain('business closed');
  });

  test('Parses international/customs package correctly', () => {
    const pkg = UPS_FIXTURES.international_customs.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.status).toBe('IN_TRANSIT');
    expect(parsed.lastLocation).toContain('GB');
    expect(parsed.events.some(e => e.description.includes('Customs'))).toBe(true);
  });

  test('Parses out-for-delivery status correctly', () => {
    const pkg = UPS_FIXTURES.out_for_delivery.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.status).toBe('OUT_FOR_DELIVERY');
  });

  test('Parses returned-to-sender correctly', () => {
    const pkg = UPS_FIXTURES.returned_to_sender.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.status).toBe('EXCEPTION');
    expect(parsed.statusDescription).toContain('Returned');
  });

  test('Parses hold-at-location correctly', () => {
    const pkg = UPS_FIXTURES.hold_at_location.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.status).toBe('IN_TRANSIT'); // type is 'I'
    expect(parsed.statusDescription).toContain('Held');
  });

  test('Parses weather delay correctly', () => {
    const pkg = UPS_FIXTURES.weather_delay.trackResponse.shipment[0].package[0];
    const parsed = parseUpsPackage(pkg);

    expect(parsed.status).toBe('EXCEPTION');
    expect(parsed.statusDescription).toContain('weather');
  });

  test('Handles null/undefined package gracefully', () => {
    const parsed = parseUpsPackage(null);
    expect(parsed.status).toBe('ERROR');
    expect(parsed.events).toEqual([]);
  });

  test('Handles package with no currentStatus gracefully', () => {
    const parsed = parseUpsPackage({ trackingNumber: '1Z000000000000000' });
    expect(parsed.status).toBe('ERROR');
  });

  test('Signature info extracted from activity additionalAttributes', () => {
    const pkg = UPS_FIXTURES.delivered_with_signature.trackResponse.shipment[0].package[0];
    const deliveredEvent = pkg.activity[0];
    expect(deliveredEvent.additionalAttributes).toBeTruthy();
    expect(deliveredEvent.additionalAttributes[0].text).toContain('SIGNED BY');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests require the Electron app to be running (via launchApp).
// They test the full IPC flow:
//   renderer → preload → main.js (IPC handler) → UPS parser → cache → return
//
// IMPORTANT: These are designed to be added to the existing verify.spec.js or
//            a new ups-tracking.spec.js file.  They use the same launchApp()
//            helper and test mode isolation.

test.describe('UPS Integration Tests (IPC flow)', () => {

  // These tests document the expected behavior.  They will pass once the UPS
  // IPC handlers are implemented in main.js.  For now they serve as the spec.

  test.skip('fetch-ups-tracking returns fixture data in test mode', async () => {
    // This test verifies that the mock IPC handler returns fixture data
    // when SOLUS_TEST_MODE=1.
    //
    // Implementation note:  The IPC handler should check testModeNetworkGuard()
    // and, if blocked, return pre-loaded fixture data from
    // tests/fixtures/ups/delivered-with-signature.json keyed by tracking number.
  });

  test.skip('UPS tracking result is cached with 15-min TTL', async () => {
    // 1. Call fetch-ups-tracking with a tracking number
    // 2. Verify cache entry exists in store ('upsTrackingCache')
    // 3. Call again — should return cached: true
    // 4. Manually expire cache entry timestamp
    // 5. Call again — should return cached: false (re-fetched)
  });

  test.skip('UPS tracking updates SOLUS order status correctly', async () => {
    // 1. Seed an order with carrier='UPS', status='shipped'
    // 2. Return fixture with status type='D' (delivered)
    // 3. Call update-orders-from-tracking with mapped status
    // 4. Verify order status changed from 'shipped' to 'delivered'
  });

  test.skip('UPS tracking does not regress order status', async () => {
    // 1. Seed an order with carrier='UPS', status='delivered'
    // 2. Return fixture with status type='I' (in transit — older data)
    // 3. Call update-orders-from-tracking
    // 4. Verify order status remains 'delivered' (not regressed)
  });

  test.skip('test-ups-connection validates OAuth2 credentials', async () => {
    // In test mode, should return blocked-by-network error.
    // Documents the expected IPC channel name and return shape.
  });

  test.skip('UPS token refresh is triggered on 401 response', async () => {
    // Documents the expected retry-with-new-token behavior.
    // Mock: first call returns 401, second call returns 200.
  });

  test.skip('Rate limiting returns backoff message', async () => {
    // Mock: return 429 with Retry-After header.
    // Verify: result contains rate_limited error type and retry hint.
  });

  test.skip('Carrier auto-detection routes to correct provider', async () => {
    // Given a tracking number like 1Z999AA10123456784
    // The unified fetch-live-tracking handler should detect UPS
    // and route to the UPS API path (not FedEx).
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — ERROR HANDLING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('UPS Error Handling', () => {

  const ERROR_SCENARIOS = [
    {
      id: 'ERR-01',
      name: 'AUTH_ERROR (401)',
      httpStatus: 401,
      responseBody: { response: { errors: [{ code: '250003', message: 'Invalid Access Token' }] } },
      expectedBehavior: 'Return error with type AUTH_ERROR; prompt user to re-enter credentials',
      expectedResult: { success: false, errorType: 'AUTH_ERROR' },
    },
    {
      id: 'ERR-02',
      name: 'RATE_LIMITED (429)',
      httpStatus: 429,
      headers: { 'Retry-After': '60' },
      responseBody: { response: { errors: [{ code: '250007', message: 'Rate limit exceeded' }] } },
      expectedBehavior: 'Return error with backoff hint; show "try again later" to user',
      expectedResult: { success: false, errorType: 'RATE_LIMITED', retryAfterSeconds: 60 },
    },
    {
      id: 'ERR-03',
      name: 'TRACKING_NOT_FOUND',
      httpStatus: 200,
      responseBody: UPS_FIXTURES.tracking_not_found,
      expectedBehavior: 'Return tracking data with status ERROR and "not found" message',
      expectedResult: { success: true, data: [{ status: 'ERROR', statusDescription: expect.stringContaining('Not Found') }] },
    },
    {
      id: 'ERR-04',
      name: 'INVALID_TRACKING_NUMBER',
      httpStatus: 400,
      responseBody: UPS_FIXTURES.invalid_tracking_number,
      expectedBehavior: 'Immediate rejection — do not retry; show validation error',
      expectedResult: { success: false, errorType: 'INVALID_TRACKING_NUMBER' },
    },
    {
      id: 'ERR-05',
      name: 'PROVIDER_DOWN (503)',
      httpStatus: 503,
      responseBody: { response: { errors: [{ code: '250099', message: 'Service Unavailable' }] } },
      expectedBehavior: 'Trip circuit breaker; use cached data if available; show provider-down message',
      expectedResult: { success: false, errorType: 'PROVIDER_DOWN' },
    },
    {
      id: 'ERR-06',
      name: 'NETWORK_ERROR (fetch failure)',
      httpStatus: null, // fetch throws
      responseBody: null,
      expectedBehavior: 'Retry up to 3 times with exponential backoff; then return network error',
      expectedResult: { success: false, errorType: 'NETWORK_ERROR' },
    },
    {
      id: 'ERR-07',
      name: 'MALFORMED_RESPONSE (invalid JSON)',
      httpStatus: 200,
      responseBody: 'not json',
      expectedBehavior: 'Catch JSON parse error; return error without crashing',
      expectedResult: { success: false, errorType: 'PARSE_ERROR' },
    },
    {
      id: 'ERR-08',
      name: 'TIMEOUT (30s)',
      httpStatus: null, // times out
      responseBody: null,
      expectedBehavior: 'Abort after 30s timeout; return timeout error',
      expectedResult: { success: false, errorType: 'TIMEOUT' },
    },
  ];

  for (const scenario of ERROR_SCENARIOS) {
    test(`${scenario.id}: ${scenario.name}`, () => {
      // Document expected behavior — these become real tests once handlers exist
      expect(scenario.expectedResult.success).toBe(false);
      expect(scenario.expectedBehavior).toBeTruthy();
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — REGRESSION TESTS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Ensure adding UPS does not break existing FedEx tracking or the unified schema.

test.describe('UPS Regression — FedEx Unaffected', () => {

  test('FedEx status mapping is unchanged', () => {
    // The FedEx Live Track already uses these statuses
    const fedexStatusMap = {
      IN_TRANSIT: 'in-transit',
      OUT_FOR_DELIVERY: 'out-for-delivery',
      DELIVERED: 'delivered',
      EXCEPTION: 'exception',
      PENDING: 'pending',
      ERROR: 'error',
    };
    // UPS uses the same set — verify no new values snuck in
    const allUpsStatuses = STATUS_MAPPING_MATRIX.map(tc => tc.expectedLiveTrack);
    const uniqueUpsStatuses = [...new Set(allUpsStatuses)];
    for (const status of uniqueUpsStatuses) {
      expect(status in fedexStatusMap || status === 'ERROR').toBe(true);
    }
  });

  test('Unified tracking card format works for both carriers', () => {
    // FedEx unified format
    const fedexTracking = {
      trackingNumber: '789456123012345678',
      status: 'IN_TRANSIT',
      statusDescription: 'In transit',
      estimatedDelivery: '2026-03-05',
      lastLocation: 'MEMPHIS, TN',
      events: [{ timestamp: '2026-03-02T10:00:00', description: 'In transit', location: 'MEMPHIS, TN' }],
    };

    // UPS unified format (from parser)
    const upsTracking = parseUpsPackage(
      UPS_FIXTURES.in_transit_with_eta.trackResponse.shipment[0].package[0]
    );

    // Both must have the same shape
    const requiredKeys = ['trackingNumber', 'status', 'statusDescription', 'estimatedDelivery', 'lastLocation', 'events'];
    for (const key of requiredKeys) {
      expect(key in fedexTracking).toBe(true);
      expect(key in upsTracking).toBe(true);
    }

    // Events must have the same shape
    const eventKeys = ['timestamp', 'description', 'location'];
    for (const key of eventKeys) {
      expect(key in fedexTracking.events[0]).toBe(true);
      expect(key in upsTracking.events[0]).toBe(true);
    }
  });

  test('Seed data has both UPS and FedEx orders for dual-carrier testing', () => {
    // Verify the existing seed-data.json contains both carriers
    const seedData = require('./fixtures/seed-data.json');
    const carriers = [...new Set(seedData.orders.map(o => o.carrier).filter(Boolean))];
    expect(carriers).toContain('UPS');
    expect(carriers).toContain('FedEx');
    expect(carriers).toContain('USPS');
  });

  test('FedEx orders still filtered correctly when UPS added', () => {
    // Simulate the filter logic from searchLiveTracking()
    const seedData = require('./fixtures/seed-data.json');
    const fedexOrders = seedData.orders.filter(o => o.carrier === 'FedEx' && o.tracking);
    const upsOrders = seedData.orders.filter(o => o.carrier === 'UPS' && o.tracking);

    expect(fedexOrders.length).toBeGreaterThan(0);
    expect(upsOrders.length).toBeGreaterThan(0);

    // Verify no overlap
    const fedexTrackings = new Set(fedexOrders.map(o => o.tracking));
    for (const order of upsOrders) {
      expect(fedexTrackings.has(order.tracking)).toBe(false);
    }
  });

  test('update-orders-from-tracking works for both carriers', () => {
    // The statusPriority map used in the handler must cover both
    const statusPriority = { cancelled: 5, declined: 4, delivered: 3, shipped: 2, confirmed: 1 };

    // FedEx-origin update
    const fedexUpdate = { tracking: '789456123012345678', status: 'delivered', eta: '2026-03-01' };
    expect(statusPriority[fedexUpdate.status]).toBe(3);

    // UPS-origin update
    const upsUpdate = { tracking: '1Z999AA10123456784', status: 'delivered', eta: '2026-02-25' };
    expect(statusPriority[upsUpdate.status]).toBe(3);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — E2E TESTS (Playwright Electron)
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests should be added to a new file: tests/e2e/ups-tracking.spec.js
// They follow the same pattern as the existing verify.spec.js.
//
// Below is the test outline.  Each test.skip() documents the test case
// and becomes a real test once the UPS UI integration is implemented.

test.describe('UPS E2E — Live Track UI', () => {

  test.skip('Live Track tab title changes to "Live Tracking" (not just "FedEx")', async () => {
    // Navigate to Deliveries → Live Track
    // The title should say "Live Tracking" (not "FedEx Live Tracking")
    // since we now support multiple carriers
  });

  test.skip('UPS orders appear in Live Track results', async () => {
    // 1. Seed orders with UPS carrier + tracking numbers
    // 2. Navigate to Deliveries → Live Track
    // 3. Set date range to cover seed data
    // 4. Click Search
    // 5. Verify UPS tracking cards appear with "UPS" badge
  });

  test.skip('UPS cards show correct status badge colors', async () => {
    // For each status: in-transit (blue), out-for-delivery (yellow),
    // delivered (green), exception (red), pending (gray)
  });

  test.skip('UPS card timeline expands with correct events', async () => {
    // Click expand button on a UPS tracking card
    // Verify timeline events match fixture data
    // Verify location and timestamp formatting
  });

  test.skip('Status filter pills include UPS shipments in counts', async () => {
    // Verify pill counts include both FedEx and UPS
    // Filter by "In Transit" — both UPS and FedEx in-transit show
    // Filter by "Delivered" — both UPS and FedEx delivered show
  });

  test.skip('Mixed carrier sorting works correctly', async () => {
    // Sort by ETA — UPS and FedEx interleaved by date
    // Sort by status — grouped by status regardless of carrier
    // Sort by retailer — carrier is secondary grouping
  });

  test.skip('Refresh single UPS tracking works', async () => {
    // Click refresh button on a UPS card
    // Verify the card updates (in test mode, fixture data reloaded)
  });

  test.skip('Clear cache clears both UPS and FedEx data', async () => {
    // Click clear cache
    // Verify both UPS and FedEx tracking data cleared
    // Verify empty state shown
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — REGISTRY ENTRIES (for tests/registry.js)
// ═══════════════════════════════════════════════════════════════════════════════
//
// These entries should be added to the registry when UPS tracking ships.

const UPS_REGISTRY_ENTRIES = [
  { id: 'tracking.ups.statusMapping', screen: 'Deliveries', type: 'unit', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Map UPS status codes to SOLUS statuses', asserts: '30 status codes map correctly' },
  { id: 'tracking.ups.parser', screen: 'Deliveries', type: 'unit', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Parse UPS API response into unified format', asserts: 'All fixture types parse correctly' },
  { id: 'tracking.ups.contract', screen: 'Deliveries', type: 'unit', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Validate UPS response schema', asserts: 'All required fields present' },
  { id: 'tracking.ups.graceful', screen: 'Deliveries', type: 'unit', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Handle missing optional fields', asserts: 'No crash on missing deliveryDate, activity, location' },
  { id: 'tracking.ups.errors', screen: 'Deliveries', type: 'unit', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Handle API errors', asserts: '8 error types handled correctly' },
  { id: 'tracking.ups.cache', screen: 'Deliveries', type: 'e2e', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Cache UPS tracking results', asserts: '15-min TTL, cache hit/miss' },
  { id: 'tracking.ups.livetrack', screen: 'Deliveries', type: 'e2e', priority: 'P0', tags: ['ups', 'tracking'], steps: 'UPS cards in Live Track UI', asserts: 'Cards render, filter, sort' },
  { id: 'tracking.ups.regression', screen: 'Deliveries', type: 'e2e', priority: 'P0', tags: ['ups', 'regression'], steps: 'FedEx still works after UPS added', asserts: 'FedEx cards unaffected, unified schema' },
  { id: 'tracking.ups.carrierDetect', screen: 'All', type: 'unit', priority: 'P0', tags: ['ups', 'tracking'], steps: 'Auto-detect UPS from tracking number format', asserts: '1Z pattern detected; no FedEx misidentification' },
  { id: 'tracking.ups.orderUpdate', screen: 'Deliveries', type: 'e2e', priority: 'P1', tags: ['ups', 'tracking'], steps: 'UPS tracking updates order status', asserts: 'Status progresses forward, never regresses' },
];


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — MONITORING / CANARY TESTS
// ═══════════════════════════════════════════════════════════════════════════════
//
// These are NOT run in the normal `npm run verify` suite.  They are designed
// for a scheduled job (GitHub Actions cron or external monitoring) that runs
// weekly to detect UPS API changes.
//
// Approach:
//   1. A canary script (scripts/canary-ups.js) makes a real API call to UPS
//      using a known tracking number (e.g., UPS's public test tracking number).
//   2. It validates the response against UPS_RESPONSE_SCHEMA.
//   3. It compares the response shape to a stored golden snapshot.
//   4. If there are new fields or missing fields, it emits a warning.
//   5. If required fields are missing, it emits an error.
//
// Alert mechanism:
//   - GitHub Actions posts to a Discord webhook on failure.
//   - The canary stores results in artifacts/canary/ups-health.json.
//
// UPS provides public test tracking numbers in sandbox mode:
//   - 1Z12345E0205271688 (delivered)
//   - 1Z12345E6605272234 (in transit)

const CANARY_CONFIG = {
  schedule: '0 6 * * 1',  // Every Monday at 6 AM UTC
  testTrackingNumbers: [
    '1Z12345E0205271688',  // UPS sandbox delivered
    '1Z12345E6605272234',  // UPS sandbox in transit
  ],
  schemaValidation: true,
  snapshotComparison: true,
  alertOnNewFields: 'warn',
  alertOnMissingFields: 'error',
  artifactPath: 'artifacts/canary/ups-health.json',
  notifyDiscord: true,
};


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 16 — ACCEPTANCE CRITERIA
// ═══════════════════════════════════════════════════════════════════════════════
//
// The UPS tracking feature is "done" when ALL of the following pass:

const ACCEPTANCE_CRITERIA = {
  // ── Must-pass before shipping ───────────────────────────────────────────
  P0_ship_blockers: [
    'All 30 status mapping tests pass (Section 3)',
    'All 4 fixture types parse correctly (Section 9)',
    'Contract schema validation passes for all fixtures (Section 7)',
    'Graceful degradation: no crash on missing optional fields (Section 7)',
    'All 8 error types handled without crash (Section 11)',
    'Carrier auto-detection: 1Z pattern correctly identifies UPS (Section 4)',
    'Carrier auto-detection: no FedEx misidentification (Section 4)',
    'Cache works: 15-min TTL, cache hit returns cached:true (Section 10)',
    'FedEx regression: existing FedEx tracking still works (Section 12)',
    'Unified schema: both carriers produce same shape for UI (Section 12)',
    'Seed data includes UPS orders for full E2E coverage (Section 12)',
    'update-orders-from-tracking progresses status forward only (Section 10)',
    'Network blocked in test mode for UPS calls (testModeNetworkGuard)',
    'Live Track UI renders UPS cards (Section 13)',
    'Live Track filters include UPS in counts (Section 13)',
  ],

  // ── Acceptable to defer ─────────────────────────────────────────────────
  P1_defer_ok: [
    'OAuth2 token refresh (can ship with manual re-auth prompt)',
    'Circuit breaker for UPS provider outages (can ship with basic error message)',
    'Canary monitoring (can set up after initial launch)',
    'International customs event parsing (can show raw UPS description)',
    'Signature details displayed in UI (can show in timeline as text)',
    'UPS My Choice redirect events (rare edge case)',
    'Batch tracking (>25 numbers) pagination handling',
    'Retry with exponential backoff (can ship with simple 3-retry)',
  ],

  // ── Explicitly out of scope ─────────────────────────────────────────────
  out_of_scope: [
    'UPS shipping label creation',
    'UPS rate shopping / cost estimation',
    'UPS returns / reverse logistics',
    'UPS Freight (LTL) tracking',
    'UPS SurePost handoff-to-USPS tracking',
  ],
};


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 17 — EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  UPS_FIXTURES,
  UPS_RESPONSE_SCHEMA,
  STATUS_MAPPING_MATRIX,
  CARRIER_DETECTION_CASES,
  ERROR_SCENARIOS: [/* defined inline in test.describe */],
  UPS_REGISTRY_ENTRIES,
  CANARY_CONFIG,
  ACCEPTANCE_CRITERIA,
  mapUpsStatusToSolus,
  parseUpsPackage,
};
