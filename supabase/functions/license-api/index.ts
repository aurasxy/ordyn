import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Rate limiting (in-memory, resets on cold start) ──
const rateLimits = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 20        // max requests per window
const RATE_WINDOW = 60_000   // 1 minute

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const entry = rateLimits.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_WINDOW })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT
}

// Stricter limit for activate (prevent brute-force key guessing)
const activateLimits = new Map<string, { count: number; resetAt: number }>()
const ACTIVATE_LIMIT = 5
const ACTIVATE_WINDOW = 300_000  // 5 minutes

function checkActivateLimit(key: string): boolean {
  const now = Date.now()
  const entry = activateLimits.get(key)
  if (!entry || now > entry.resetAt) {
    activateLimits.set(key, { count: 1, resetAt: now + ACTIVATE_WINDOW })
    return true
  }
  entry.count++
  return entry.count <= ACTIVATE_LIMIT
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Rate limit by IP
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const url = new URL(req.url)
    const action = url.pathname.split('/').pop()
    const body = await req.json().catch(() => ({}))

    // Stricter rate limit on activate (key guessing prevention)
    if (action === 'activate') {
      if (!checkActivateLimit(clientIp)) {
        return new Response(
          JSON.stringify({ error: 'Too many activation attempts. Please wait 5 minutes.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    let result
    switch (action) {
      case 'validate':
        result = await validateLicense(supabase, body)
        break
      case 'activate':
        result = await activateLicense(supabase, body)
        break
      case 'heartbeat':
        result = await heartbeat(supabase, body)
        break
      case 'deactivate':
        result = await deactivateLicense(supabase, body)
        break
      default:
        result = { error: 'Unknown action' }
    }

    return new Response(
      JSON.stringify(result),
      {
        status: result.error ? 400 : 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function validateLicense(supabase: any, body: any) {
  const { licenseKey } = body

  if (!licenseKey) {
    return { error: 'License key required' }
  }

  const { data: licenses, error } = await supabase
    .from('licenses')
    .select('id, is_active, plan, expires_at, max_activations')
    .eq('license_key', licenseKey)
    .limit(1)

  if (error || !licenses || licenses.length === 0) {
    return { error: 'Invalid license key' }
  }

  const license = licenses[0]

  if (!license.is_active) {
    return { error: 'License has been revoked' }
  }

  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return { error: 'License has expired' }
  }

  return {
    valid: true,
    license: {
      id: license.id,
      plan: license.plan,
      expiresAt: license.expires_at,
      maxActivations: license.max_activations
    }
  }
}

async function activateLicense(supabase: any, body: any) {
  const { licenseKey, machineId, appVersion, osInfo } = body

  if (!licenseKey || !machineId) {
    return { error: 'License key and machine ID required' }
  }

  const validation = await validateLicense(supabase, { licenseKey })
  if (!validation.valid) {
    return { error: validation.error }
  }

  const license = validation.license

  const { data: existingActivations } = await supabase
    .from('activations')
    .select('*')
    .eq('license_id', license.id)
    .eq('machine_id', machineId)

  if (existingActivations && existingActivations.length > 0) {
    const existing = existingActivations[0]

    await supabase
      .from('activations')
      .update({
        is_active: true,
        last_heartbeat: new Date().toISOString(),
        app_version: appVersion
      })
      .eq('id', existing.id)

    return {
      success: true,
      activationId: existing.id,
      license: {
        id: license.id,
        plan: license.plan,
        expiresAt: license.expiresAt
      }
    }
  }

  const { data: activeActivations } = await supabase
    .from('activations')
    .select('id')
    .eq('license_id', license.id)
    .eq('is_active', true)

  if (activeActivations && activeActivations.length >= license.maxActivations) {
    return { error: `Maximum activations reached (${license.maxActivations})` }
  }

  const { data: newActivation, error } = await supabase
    .from('activations')
    .insert({
      license_id: license.id,
      machine_id: machineId,
      app_version: appVersion,
      os_info: osInfo,
      is_active: true,
      last_heartbeat: new Date().toISOString()
    })
    .select()

  if (error || !newActivation || newActivation.length === 0) {
    return { error: 'Failed to create activation' }
  }

  return {
    success: true,
    activationId: newActivation[0].id,
    license: {
      id: license.id,
      plan: license.plan,
      expiresAt: license.expiresAt
    }
  }
}

async function heartbeat(supabase: any, body: any) {
  const { activationId, appVersion } = body

  if (!activationId) {
    return { error: 'Activation ID required' }
  }

  const { error } = await supabase
    .from('activations')
    .update({
      last_heartbeat: new Date().toISOString(),
      app_version: appVersion
    })
    .eq('id', activationId)
    .eq('is_active', true)

  if (error) {
    return { error: 'Heartbeat failed' }
  }

  return { success: true }
}

async function deactivateLicense(supabase: any, body: any) {
  const { activationId } = body

  if (!activationId) {
    return { error: 'Activation ID required' }
  }

  await supabase
    .from('activations')
    .update({ is_active: false })
    .eq('id', activationId)

  return { success: true }
}
