import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status)
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const action = url.pathname.split('/').pop()
    const body = await req.json()
    const { licenseKey } = body

    if (!licenseKey) {
      return errorResponse('Missing license key')
    }

    switch (action) {
      case 'check-link':
        return handleCheckLink(licenseKey)
      case 'generate-token':
        return handleGenerateToken(licenseKey)
      case 'sync-orders':
        return handleSyncOrders(licenseKey)
      case 'get-link-status':
        return handleGetLinkStatus(licenseKey)
      case 'unlink':
        return handleUnlink(licenseKey)
      default:
        return errorResponse('Unknown action: ' + action, 404)
    }
  } catch (err) {
    console.error('Edge function error:', err)
    return errorResponse(err.message || 'Internal error', 500)
  }
})

// ── check-link: Get basic link status for settings page ──
async function handleCheckLink(licenseKey: string) {
  const { data: rows, error } = await supabase
    .from('discord_links')
    .select('discord_username')
    .eq('license_key', licenseKey)
    .eq('is_active', true)

  if (error) return errorResponse(error.message, 500)

  const linked = rows && rows.length > 0
  const discordUsername = linked ? rows[0].discord_username : null

  return jsonResponse({ linked, discordUsername })
}

// ── generate-token: Create a 6-char link token ──
async function handleGenerateToken(licenseKey: string) {
  const { token, expiresAt } = body_token()

  // Delete any existing unlinked rows (expired unused tokens)
  await supabase
    .from('discord_links')
    .delete()
    .eq('license_key', licenseKey)
    .is('discord_user_id', null)

  // Check if a linked row already exists
  const { data: existing } = await supabase
    .from('discord_links')
    .select('id')
    .eq('license_key', licenseKey)
    .not('discord_user_id', 'is', null)

  if (existing && existing.length > 0) {
    // Update existing linked row with new token
    const { error } = await supabase
      .from('discord_links')
      .update({ link_token: token, token_expires_at: expiresAt })
      .eq('license_key', licenseKey)
      .not('discord_user_id', 'is', null)

    if (error) return errorResponse(error.message, 500)
  } else {
    // Insert new row
    const { error } = await supabase
      .from('discord_links')
      .insert({
        license_key: licenseKey,
        link_token: token,
        token_expires_at: expiresAt,
        discord_user_id: null,
      })

    if (error) return errorResponse(error.message, 500)
  }

  return jsonResponse({ success: true, token })
}

// ── sync-orders: Fetch unfetched orders and delete them from relay ──
async function handleSyncOrders(licenseKey: string) {
  // Get unfetched orders
  const { data: rows, error } = await supabase
    .from('discord_orders')
    .select('*')
    .eq('license_key', licenseKey)
    .is('fetched_at', null)

  if (error) return errorResponse(error.message, 500)

  if (!rows || rows.length === 0) {
    return jsonResponse({ orders: [] })
  }

  // Delete fetched rows from relay
  const messageIds = rows.map((r: any) => r.message_id).filter(Boolean)
  if (messageIds.length > 0) {
    await supabase
      .from('discord_orders')
      .delete()
      .in('message_id', messageIds)
  }

  return jsonResponse({ orders: rows })
}

// ── get-link-status: Detailed link status with channels ──
async function handleGetLinkStatus(licenseKey: string) {
  const { data: links, error } = await supabase
    .from('discord_links')
    .select('discord_user_id, discord_username')
    .eq('license_key', licenseKey)
    .eq('is_active', true)

  if (error) return errorResponse(error.message, 500)

  if (!links || links.length === 0) {
    return jsonResponse({ linked: false })
  }

  const link = links[0]
  const discordUserId = link.discord_user_id
  const discordUsername = link.discord_username || null

  let channels: any[] = []

  if (discordUserId) {
    const { data: channelRows } = await supabase
      .from('discord_channels')
      .select('channel_name, channel_id, aco_bot_type')
      .eq('discord_user_id', discordUserId)
      .eq('is_active', true)

    if (channelRows && channelRows.length > 0) {
      channels = channelRows.map((ch: any) => ({
        name: ch.channel_name,
        id: ch.channel_id,
        botType: ch.aco_bot_type,
        guildName: null,
      }))
    }
  }

  return jsonResponse({
    linked: true,
    discordUsername,
    channelCount: channels.length,
    channels,
  })
}

// ── unlink: Remove Discord link and associated channels ──
async function handleUnlink(licenseKey: string) {
  // Get discord_user_ids for this license
  const { data: links } = await supabase
    .from('discord_links')
    .select('discord_user_id')
    .eq('license_key', licenseKey)

  if (links && links.length > 0) {
    for (const link of links) {
      if (link.discord_user_id) {
        await supabase
          .from('discord_channels')
          .delete()
          .eq('discord_user_id', link.discord_user_id)
      }
    }
  }

  // Delete the link rows
  await supabase
    .from('discord_links')
    .delete()
    .eq('license_key', licenseKey)

  return jsonResponse({ success: true })
}

// ── Helper: generate random token ──
function body_token() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let token = ''
  for (let i = 0; i < 6; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  return { token, expiresAt }
}
