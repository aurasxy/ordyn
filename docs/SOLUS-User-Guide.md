# SOLUS User Guide

**Version 2.0.0** | Order Analytics for Walmart, Target, Pokemon Center & More

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Data Modes](#2-data-modes)
3. [IMAP Email Setup](#3-imap-email-setup)
4. [Discord Integration](#4-discord-integration)
5. [Dashboard](#5-dashboard)
6. [Retailer Pages](#6-retailer-pages)
7. [Deliveries](#7-deliveries)
8. [Analytics](#8-analytics)
9. [Account Stats](#9-account-stats)
10. [Inventory & TCG](#10-inventory--tcg-tracker)
11. [Reports](#11-reports)
12. [Settings](#12-settings)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Getting Started

### Welcome to SOLUS

SOLUS is a powerful order analytics application that automatically tracks and analyzes your orders from major retailers. Whether you're monitoring retail drops, managing multiple accounts, or tracking your inventory, SOLUS provides the insights you need.

**Key Features:**
- **Multi-Retailer Support** — Track orders from Walmart, Target, Pokemon Center, Best Buy, Costco, and Sam's Club
- **Dual Import Methods** — Import orders via IMAP email sync or Discord bot integration
- **Comprehensive Analytics** — View detailed charts, metrics, and insights about your orders
- **Inventory Tracking** — Monitor your inventory with TCGPlayer price integration

### First Launch

1. **Enter Your License Key** — Paste the license key you received (format: `SOLUS-XXXX-XXXX-XXXX`)
2. **Choose Your Data Mode** — Select Email (IMAP) or Discord
3. **Connect Your Data Source** — Add email accounts or link Discord
4. **Start Syncing** — Click "Sync Now" to begin importing orders

### Supported Retailers

- Walmart
- Target
- Pokemon Center
- Best Buy
- Costco
- Sam's Club

---

## 2. Data Modes

SOLUS offers two ways to import your order data. You can switch between them at any time, but only one mode is active at a time.

### IMAP Mode (Email)

Connect your email accounts to automatically sync order confirmations, shipping updates, and delivery notifications directly from your inbox.

**Benefits:**
- Full order lifecycle tracking
- Shipping carrier & tracking info
- Delivery address extraction
- Price and item details

### Discord Mode

Link your Discord account and watch channels where order bots post confirmations. Great for ACO and similar automation tools.

**Benefits:**
- Bot profile tracking
- Order confirmations & cancellations
- Profile-based grouping
- Real-time sync

### Mode-Specific UI

| Feature | IMAP Mode | Discord Mode |
|---------|-----------|--------------|
| Deliveries Page | Visible | Hidden |
| Shipped/Delivered Stats | Visible | Hidden |
| Carriers Tab (Analytics) | Visible | Hidden |
| Account Stats | Groups by Email | Groups by Profile |
| IMAP Nav | Visible | Hidden |
| Discord Nav | Hidden | Visible |

### Switching Modes

1. Go to **Settings** (gear icon in sidebar)
2. Under **General** tab, find "Data Mode"
3. Select **Email (IMAP)** or **Discord**
4. The UI will instantly update

> **Note:** Switching modes doesn't delete your data. Orders from both sources are stored separately.

---

## 3. IMAP Email Setup

IMAP mode connects directly to your email inbox to import order emails.

### Adding an Email Account

1. Navigate to **IMAP** page in the sidebar
2. Click **"Add Account"**
3. Select your provider (Gmail, Outlook, Yahoo, or Custom)
4. Enter your email and **App Password**
5. Click **"Test Connection"** then **"Save"**

### Gmail App Password Setup

> ⚠️ **Important:** Gmail requires an App Password. Your regular password will not work.

1. **Enable 2-Factor Authentication** at `myaccount.google.com/security`
2. **Generate App Password** at `myaccount.google.com/apppasswords`
3. Select "Mail" and "Windows Computer"
4. **Copy the 16-character password** (no spaces)
5. **Use this in SOLUS** (not your Google password)

### Sync Settings

| Setting | Description |
|---------|-------------|
| Auto-Sync Interval | How often to automatically sync (30 min, 1h, 2h, 4h, 8h, or disabled) |
| Sync on Startup | Automatically sync when you open SOLUS |
| Auto-Resume | Automatically retry failed syncs after a delay |
| Date Range | Only sync emails within a specific date range |

### Proxy Support

1. Go to **Settings → IMAP → Proxy Settings**
2. Add proxy in format `host:port:username:password`
3. Click **"Test"** to verify
4. Enable **"Use Proxy"** for the account

---

## 4. Discord Integration

Discord mode allows you to import orders posted by automation bots in Discord channels.

### Linking Your Discord Account

1. Navigate to **Discord** page in the sidebar
2. Click **"Invite Bot to Server"** to add the SOLUS bot
3. Click **"Generate Token"** to create a link code
4. In Discord, use `/link` command with the token

### Watching Channels

1. In Discord, navigate to the order channel
2. Use `/watch` to start monitoring
3. Channel appears in your "Watched Channels" list
4. Use `/unwatch` to stop monitoring

### Syncing Discord Orders

| Setting | Description |
|---------|-------------|
| Auto-Sync | Enable automatic syncing |
| Sync Interval | 5, 15, 30, or 60 minutes |
| Sync Now | Manual immediate sync |
| Clear Orders | Remove all Discord orders |

### Discord Webhooks

1. In Discord: Right-click channel → Edit → Integrations → Webhooks
2. Create webhook and copy URL
3. In SOLUS: **Settings → Reports**
4. Paste webhook URL and click **"Test"**

---

## 5. Dashboard

The Dashboard provides an at-a-glance overview of your order activity.

### Summary Cards

- **Confirmed** — Orders placed and acknowledged
- **Shipped** — Orders in transit (IMAP only)
- **Delivered** — Orders delivered (IMAP only)
- **Cancelled** — Orders cancelled

### Retailer Cards

Each retailer shows:
- Order counts by status
- Total spent
- Stick rate
- Recent activity

Click any card to view detailed orders.

### Time Period Filter

- **7D** — Last 7 days
- **30D** — Last 30 days
- **90D** — Last 90 days
- **All** — All time

---

## 6. Retailer Pages

Each retailer has a dedicated page showing all orders.

### Drop View

Orders are grouped by "drops" — the date you placed orders. Each drop card shows:
- Date
- Order count
- Status breakdown (Confirmed vs. Cancelled)
- Stick rate
- Total value

### Order Details

Click an order to view:
- Order ID
- Item name and quantity
- Price
- Status
- Tracking (if shipped)
- Address
- Profile (Discord mode)

### Bulk Actions

1. Click checkboxes to select orders
2. Use "Select All" for all visible orders
3. Choose action: Mark Delivered, Delete, or Export

### Flex Modal

For multi-item orders, view all items with images and per-item pricing. Export as PNG or share to Discord.

---

## 7. Deliveries

> **IMAP Mode Only** — Discord doesn't provide shipping updates.

The Deliveries page tracks packages by shipping address.

### Address Grouping

Orders grouped by address showing:
- Full shipping address
- Pending deliveries count
- Delivered packages count
- List of orders

### Jig Detection

Enable in Settings to:
- Automatically link similar addresses
- Detect leetspeak patterns
- Use AYCD jig expressions
- Manually link/unlink with drag-and-drop

### Tracking Packages

Click tracking button to open carrier's page. Supported: FedEx, UPS, USPS, DHL, OnTrac

---

## 8. Analytics

Visual insights through charts, graphs, and metrics.

### Analytics Tabs

- **Overview** — Order volume, spending trends, retailer breakdown
- **Retailers** — Per-retailer statistics and comparisons
- **Items** — Most ordered products, item-level analytics
- **Carriers** — Shipping carrier performance (IMAP only)

### Key Metrics

| Metric | Description |
|--------|-------------|
| Total Orders | Number across all retailers |
| Total Spent | Combined value |
| Avg Order Value | Average per order |
| Stick Rate | Orders not cancelled (%) |
| Cancel Rate | Orders cancelled (%) |
| Avg Delivery Days | Time to delivery (IMAP) |

---

## 9. Account Stats

Track performance for each email account (IMAP) or bot profile (Discord).

### IMAP Mode: Account Stats

- Order count
- Total spent
- Stick rate
- Performance tier (Gold/Silver/Bronze)
- Last order date

### Discord Mode: Profile Stats

- Profile name
- Bot type (ACO, etc.)
- Order count
- Stick rate
- Performance tier

### Performance Tiers

| Tier | Criteria |
|------|----------|
| **Gold** | 90%+ stick rate, consistent success |
| **Silver** | 70-89% stick rate, reliable |
| **Bronze** | 50-69% stick rate, room to improve |
| **At-Risk** | <50% stick rate, high cancellations |

---

## 10. Inventory & TCG Tracker

Track delivered items and monitor TCG prices.

### Inventory Management

- **Auto-add** delivered orders
- **Manual add** items or from TCGPlayer
- **Track quantities** and stock levels
- **Link to orders** for reference

### TCG Price Tracking

- Link items to TCGPlayer
- Track current/low/high prices
- View price history
- Bulk refresh all prices

### Portfolio Value

- Total estimated value
- Item count
- Price change indicators
- Most valuable items

---

## 11. Reports

Generate customizable reports for analysis or sharing.

### Creating a Report

1. **Select Date Range** — 7/30/90 days or all-time
2. **Choose Retailers** — Select specific or all
3. **Select Sections** — Summary, Breakdown, Top Items, etc.
4. **Generate** — Click to create

### Report Sections

| Section | Contents |
|---------|----------|
| Summary | Totals, spending, stick rate |
| Retailer Breakdown | Per-retailer stats |
| Top Items | Most ordered products |
| Account Performance | Per-account metrics |
| Carrier Stats | Shipping performance (IMAP) |

### Sharing Reports

- **Discord** — Send to webhook
- **PDF** — Export document
- **Copy** — Clipboard

### Report Templates

Save configurations for quick reuse.

---

## 12. Settings

Customize SOLUS via the gear icon in sidebar.

### General Settings

| Setting | Description |
|---------|-------------|
| Data Mode | IMAP or Discord |
| Theme | Dark or Light |
| Accent Color | 6 presets + custom |
| Flex PNG Folder | Export save location |

### Accent Colors

Purple, Blue, Green, Red, Orange, Pink, or custom picker.

### Sync Settings

| Setting | Description |
|---------|-------------|
| Auto-Sync Interval | Frequency or disabled |
| Sync on Startup | Auto-sync on open |
| Auto-Resume | Retry failed syncs |
| Skip Cooldown | Force sync if recent |

### Data Management

- **Export Data** — JSON, CSV, or PDF
- **Clear Orders** — By time range or all
- **Clear All Data** — Full reset (permanent)

> ⚠️ Clearing data is permanent. Export first!

### License Information

View key, plan type, activation date, days remaining, and disconnect option.

---

## 13. Troubleshooting

### IMAP Connection Issues

**"Authentication failed"**
- Use App Password, not regular password
- Enable 2FA for Gmail
- Check IMAP is enabled in email settings
- Verify email address

**"Connection timed out"**
- Check internet connection
- Disable VPN
- Verify proxy if using
- Wait and retry (rate limiting)

**Sync stuck or slow**
- First sync takes time with many emails
- Use date range filtering
- Pause and resume
- Check sync log for errors

### Discord Integration Issues

**"Link token expired"**
- Tokens expire after 5 minutes
- Generate new token immediately
- Use right away

**No orders syncing**
- Verify watched channels
- Check bot permissions
- Enable auto-sync
- Try manual sync

### Order Parsing Issues

**Orders showing $0**
- Some emails lack price info
- Shipping updates don't include prices
- Confirmation email should have price
- Try resyncing

**Wrong item names**
- Some formats are harder to parse
- Promo sections may confuse parser
- Parser prioritizes product indicators

### General Issues

**"Invalid license key"**
- Check for typos
- Use complete key
- Contact support if new

**App not updating**
- Updates checked on startup
- Verify internet connection
- Restart to trigger check

### Getting Help

- Check sync log for errors
- Export settings for support
- Contact with license key and error details

---

**SOLUS v2.0.0** — Order Analytics for Power Users
