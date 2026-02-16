# SOLUS User Guide v2.0
### Order Analytics for Resellers

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Dashboard](#dashboard)
3. [IMAP Accounts](#imap-accounts)
4. [Retailer Pages](#retailer-pages)
5. [Delivery Hub](#delivery-hub)
6. [Analytics](#analytics)
7. [Account Stats](#account-stats)
8. [Reports](#reports)
9. [Inventory Management](#inventory-management)
10. [TCG Price Tracker](#tcg-price-tracker)
11. [Settings](#settings)
12. [Tips & Tricks](#tips--tricks)

---

## Getting Started

### Activation
When you first launch SOLUS, you'll be prompted to enter your license key.

**License Format:** `OA-PRO-XXXX-XXXX-XXXX`

Enter your key and click **Activate License**. Once activated, you'll have full access to all features.

### Onboarding Walkthrough

After activation, a guided walkthrough tutorial will appear automatically on first launch. The walkthrough covers five steps:

1. **Welcome** - Overview of SOLUS and what it does
2. **Accounts** - How to connect your email accounts via IMAP
3. **Sync** - How to pull in order data from your emails
4. **Dashboard** - Navigating the main dashboard and retailer cards
5. **Analytics** - Understanding your charts, stick rate, and performance metrics

Each step highlights the relevant part of the UI and explains how to use it. You can skip the walkthrough at any time, or replay it later from **Settings > General > Show Walkthrough**.

### First Steps
1. **Add your email accounts** - Go to IMAP page and connect your Gmail, Yahoo, Outlook, or iCloud accounts
2. **Run your first sync** - Select date range and sync to pull in your order emails
3. **Explore your data** - View orders by retailer, check analytics, and track deliveries

---

## Dashboard

The Dashboard gives you a quick overview of all your orders across retailers.

### Retailer Cards
Each supported retailer has a card showing:
- **Confirmed** - Orders successfully placed
- **Cancelled** - Orders that were cancelled
- **Shipped** - Orders in transit
- **Delivered** - Orders that have arrived

**Click any retailer card** to jump to that retailer's detailed page.

### Customizable Dashboard

Click the **Customize** gear icon in the top-right corner of the dashboard to personalize your layout.

**Retailer Card Toggles:**
Show or hide individual retailer cards based on which retailers you actively use:
- Walmart
- Target
- Pokemon Center
- Sam's Club
- Costco
- Best Buy

**Stats Section Toggles:**
Show or hide individual stats sections to keep the dashboard focused on what matters to you.

Your layout preferences are **saved automatically** and persist across sessions. Toggle cards on and off at any time without losing any underlying data.

### Dashboard Alerts

An alerts bar appears at the top of the dashboard when there are items that need your attention. Alerts include:

- **Low Stick Rate Warning** - "X accounts below 50% stick rate" - Click to jump to Account Stats
- **Overdue Deliveries** - "X orders awaiting delivery past ETA" - Click to jump to Delivery Hub
- **Recent Cancellations** - "X orders cancelled in last 24h" - Click to view cancelled orders

Each alert is clickable and navigates you to the relevant page for more detail. Alerts can be **dismissed per session** by clicking the X on each one. They will reappear on your next launch if the conditions still apply.

### Quick Stats Bar

A persistent quick stats bar is displayed below the alerts showing at-a-glance numbers:
- **In Transit** - Total packages currently on the way
- **Arriving Today** - Deliveries expected today
- **Spending This Month** - Total confirmed order value for the current month
- **Delivered This Week** - How many packages arrived in the last 7 days

### Statistics Bar
View aggregated totals:
- Total orders across all retailers
- Total amount spent
- Overall stick rate

### Time Period Filter
Toggle between **7D**, **30D**, **90D**, or **All** to filter the dashboard data.

---

## IMAP Accounts

Connect your email accounts to automatically sync order confirmations, shipping updates, and delivery notifications.

### Supported Providers
| Provider | Badge Color | App Password Required |
|----------|-------------|----------------------|
| Gmail | Red | Yes |
| Yahoo | Purple | Yes |
| Outlook/Hotmail | Blue | Yes (or regular password) |
| iCloud | Gray | Yes |
| AOL | Orange | Yes |

### Adding an Account

1. Click **+ Add Account**
2. Select your email provider
3. Enter your email address
4. Enter your **App Password** (not your regular password)
5. Click **Test Connection** to verify
6. Click **Add Account**

> **Need help with App Passwords?** Click the help link next to each provider for setup instructions.

### Provider-Specific Help

When adding an account or when a connection test fails, SOLUS will automatically display provider-specific instructions to guide you through the setup process.

**Gmail:**
- Go to your Google Account settings
- Enable IMAP in Gmail settings (Settings > Forwarding and POP/IMAP)
- Create an App Password at [myaccount.google.com](https://myaccount.google.com) under Security > 2-Step Verification > App Passwords
- Use the generated 16-character password in SOLUS

**Outlook / Hotmail:**
- Enable IMAP in Outlook settings
- If you have 2FA enabled, you may need to generate an App Password
- Use your app password (or regular password if 2FA is off)

**Yahoo:**
- Go to [login.yahoo.com](https://login.yahoo.com) and navigate to Account Security
- Generate an App Password for "Other App"
- Use the generated password in SOLUS

**iCloud:**
- Go to [appleid.apple.com](https://appleid.apple.com) and sign in
- Under Security, generate an app-specific password
- Use that password in SOLUS

**AOL:**
- Go to [login.aol.com](https://login.aol.com) and navigate to Account Security
- Generate an App Password
- Use the generated password in SOLUS

All provider help links open externally in your default browser so you can complete the setup alongside SOLUS.

### Syncing Emails

Once an account is added, you have several sync options:

| Button | Description |
|--------|-------------|
| **Sync Recent** | Syncs from your last sync date (or last 7 days if first sync) |
| **Sync All** | Full historical sync with custom date range |
| **Rescue from Spam** | Finds order emails in spam and moves them to inbox |

### Sync Progress

During sync you'll see:
- Progress bar with email count
- Current status message
- **Pause** button (yellow) - Pause after current batch
- **Stop** button (red) - Stop immediately

### Paused Syncs & Auto-Resume

If a sync pauses (due to connection issues), you'll see:
- Yellow highlight on the account
- "Paused (X remaining)" indicator
- **Auto-resume countdown** if enabled
- **Resume** button to continue manually

**Configure Auto-Resume** in Settings > General:
- 1, 5, 10, 15, 30, or 60 minutes
- Default: 1 minute (enabled by default)

### Bulk Import

Have multiple accounts? Click **Import CSV** to bulk import accounts from a CSV file.

---

## Retailer Pages

Each retailer has its own dedicated page with detailed order information.

### Supported Retailers
- **Walmart** - Blue theme
- **Target** - Red theme
- **Pokemon Center** - Yellow theme
- **Sam's Club** - Navy theme
- **Costco** - Red theme
- **Best Buy** - Blue/Yellow theme

### Page Features

#### Statistics Grid
Quick view of order counts and totals:
- Confirmed / Cancelled / Shipped / Delivered
- Total Orders
- Total Spent

#### Pagination Info
Above the order list, a **"Showing X of Y orders"** indicator is displayed so you always know how many orders are loaded versus the total available. This updates as you apply filters or search.

#### Search
Search orders by:
- Item name
- Order ID
- Email address
- Date

Press **/** to quickly jump to search.

#### Advanced Filters

Click the **Advanced Filters** toggle button to expand a full filtering panel with the following options:

- **Date Range** - Start and end date pickers to narrow orders to a specific window
- **Amount Range** - Min and max dollar amount fields to filter by order value
- **Carrier Dropdown** - Filter by shipping carrier (UPS, FedEx, USPS, etc.)
- **Status Checkboxes** - Check/uncheck Confirmed, Cancelled, Shipped, Delivered to show only the statuses you want
- **Has Tracking Toggle** - Show only orders that have (or do not have) a tracking number
- **Account / Email Filter** - Filter orders by the specific email account they were synced from

When filters are active, a **badge** appears on the Advanced Filters button showing the count of active filters (e.g., "Filters (3)"). Click **Clear All Filters** to reset everything at once.

Filters **persist per retailer** -- switching to another tab and back will keep your filters in place. They reset when you close the app.

#### Flex to Discord

Each order card includes a **Discord icon button**. Click it to share that specific order as a "drop flex" to your configured Discord webhook. The embed sent to Discord includes:

- Item name and image
- Order amount and status
- Retailer name
- SOLUS logo branding

Configure your Discord webhook URL in **Settings > Reports** before using this feature. See the [Discord Integration](#discord-integration) section for more details.

#### Drops View
Orders are grouped by "drops" (order date):
- Drop date header
- Product image grid
- Quantity badges
- Status counts per drop
- Drop total spent

**Click a drop** to expand and see all items.

#### Multi-Select
Hold **Ctrl/Cmd** and click to select multiple drops for bulk actions.

---

## Delivery Hub

Track all your incoming packages in one place.

### Three Views

#### In Transit Tab
Shows all packages currently on the way.

**Quick Filters:**
- **Today** - Arriving today
- **This Week** - Arriving within 7 days
- **In Transit** - All shipped orders
- **Alerts** - Delivery issues

**View Modes:**
- **Timeline** - Organized by delivery date
- **By Address** - Grouped by shipping address
- **By Retailer** - Grouped by store

#### Recently Delivered Tab
View orders that have already arrived.

Filter by: Last 7 Days, 30 Days, 90 Days, Year, All Time

#### Calendar View
Visual calendar showing deliveries by date.
- Navigate months with arrows
- Click any day to see deliveries
- **Today** button jumps to current date

### Bulk Mark Delivered

Select multiple shipped items at once and mark them all as delivered in a single action.

1. **Checkboxes** appear next to each shipped item in the In Transit tab
2. Use the **Select All** checkbox in the header to select every item at once
3. When one or more items are selected, a **floating action bar** appears at the bottom of the screen
4. The action bar shows the count of selected items (e.g., "12 items selected")
5. Click the **Mark Delivered** button to mark all selected items as delivered

This is especially useful after a large drop day when multiple packages arrive at once.

### Address Linking
In **By Address** view, drag and drop addresses to link them together. This is useful for jig addresses that should be grouped.

---

## Analytics

Deep dive into your ordering performance with comprehensive charts and insights.

### Summary Cards

At the top of the Analytics page, four summary cards provide a quick snapshot:
- **Total Orders** - Combined order count for the selected period
- **Confirmed** - Number of confirmed (non-cancelled) orders
- **Total Spent** - Dollar amount across all confirmed orders
- **Stick Rate** - Percentage of orders that were confirmed vs. total placed

### Retailer Filter Tabs

Filter all analytics data by retailer using tabs at the top:
- **All** - Aggregate data across every retailer
- **Walmart**
- **Target**
- **Pokemon Center**
- **Sam's Club**
- **Costco**
- **Best Buy**

### Period Filter
- **7 Days**, **30 Days**, **90 Days**, **1 Year**, **All Time**

### Chart Toggle Bar

Use the toggle bar to show or hide individual chart sections. This keeps the page clean when you only want to focus on certain metrics. Toggles are available for:
- Spending
- Stick Rate
- Cancel Rate
- Order Volume
- Retailer Compare
- Patterns
- Carriers
- Insights

### Charts

SOLUS v2.0 includes seven full charts:

#### 1. Spending Over Time
A **line chart** showing your daily or weekly spending over the selected period. When "All" retailers is selected, each retailer is color-coded with its own line so you can compare spending patterns across stores.

#### 2. Stick Rate Trend
A **line chart** tracking your stick rate (confirmed / total) over time, drawn in the app's accent color. Useful for spotting dips that may indicate account issues.

#### 3. Cancel Rate Trend
A **line chart** showing the daily cancellation rate over time. Helps identify days or periods where cancellation rates spike so you can investigate causes.

#### 4. Order Volume
A **stacked bar chart** showing order counts per day or week. Green bars represent confirmed orders and red bars represent cancelled orders. The stacked view makes it easy to see both volume and success at a glance.

#### 5. Retailer Comparison
A **horizontal bar chart** that only appears when the "All" retailer tab is selected. Compares total orders, stick rate, and spending across all retailers side by side.

#### 6. Ordering Patterns Heatmap
A **heatmap** showing your order distribution by day of the week. Includes:
- Per-retailer tabs to see patterns for each store individually
- Color intensity based on order volume
- Peak drop day insights (e.g., "Your busiest day at Walmart is Tuesday")

#### 7. Carrier Performance
Three visualizations in one section:
- **Doughnut chart** showing carrier distribution (what percentage of orders ship via UPS, FedEx, USPS, etc.)
- **Bar chart** showing average delivery time per carrier in days
- **Stats table** with detailed carrier metrics including total shipments, average transit time, and on-time percentage

### Period Comparison

Click the **Compare** toggle to overlay the previous period's data as a dashed line on your Spending, Stick Rate, and Cancel Rate charts. For example, if you're viewing 30 Days, enabling Compare will overlay the prior 30-day period so you can see how your performance has changed.

### Performance Insights

A dedicated insights panel showing your top and bottom performers:
- **Top Items by Stick Rate** - Which products have the highest confirmation rate
- **Top Items by Spend** - Where you're spending the most
- **Top Items by Volume** - Your most-ordered products
- **Worst Performers** - Items with the highest cancellation rates

---

## Account Stats

Analyze performance by individual email account or shipping address.

### How to Use

1. Select a **Retailer** (required - no "All" option)
2. Select a **Time Period**
3. View account performance cards

### Metrics Per Account
- Total orders
- Stick rate percentage
- Total spent
- Success indicators

### Account Risk Score

Each account receives a composite **Risk Score from 0 to 100** that gives you an at-a-glance assessment of account health. The score is calculated from five weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Stick Rate | 40% | Higher stick rate = higher score |
| Order Volume Confidence | 25% | More orders = more reliable score |
| Recent Trend | 20% | Improving stick rate boosts score |
| Cancellation Pattern | 10% | Sporadic cancels score better than streaks |
| Carrier Diversity | 5% | Using multiple carriers scores slightly higher |

**Score Color Coding:**
- **Green (80-100)** - Healthy account, performing well
- **Yellow (60-79)** - Acceptable, monitor for changes
- **Orange (40-59)** - At risk, consider reducing volume
- **Red (0-39)** - High risk, investigate or retire

The Risk Score is available as a **sort option** so you can quickly surface your most at-risk accounts.

### Benchmark vs Tier

Each account card shows how it compares to the average for its tier. A benchmark indicator displays the difference, for example:

- **"vs tier avg: +5.2%"** with a green up arrow (performing above tier average)
- **"vs tier avg: -3.1%"** with a red down arrow (performing below tier average)

This helps you identify which accounts are outperforming or underperforming relative to similar accounts.

### Sorting Options
- Stick Rate (High to Low)
- Order Count (High to Low)
- Total Spent (High to Low)
- Account Name (A-Z)
- Risk Score (Low to High / High to Low)

### Advanced Filters
Click the filter icon to filter by stick rate ranges (e.g., only show accounts with 80%+ stick rate).

---

## Reports

Generate, export, and share detailed reports from your order data.

### Accessing Reports

The Reports page is accessible from the **sidebar navigation**. You can also quick-generate reports directly from the Dashboard or Analytics pages using the report icon button.

### Report Templates

Save reusable report configurations so you can generate the same report with one click.

**Creating a Template:**
1. Click **+ New Template**
2. Give it a name (e.g., "Weekly Walmart Summary" or "Monthly Full Report")
3. Select which sections to include
4. Choose the time period (7D, 30D, 90D, 1Y, All)
5. Optionally set a retailer filter (All or a specific retailer)
6. Save the template

Templates are saved and available for reuse at any time.

### Available Report Sections

When building a template, choose from the following sections to include:

- **Summary Stats** - Total orders, confirmed, cancelled, stick rate, total spent
- **Retailer Breakdown** - Per-retailer order counts and spend
- **Top Performers** - Best items by stick rate, spend, and volume
- **Account Scores** - Risk scores and stick rates per account
- **Carrier Stats** - Carrier distribution and average delivery times
- **Stick Rate Trend** - Line chart of stick rate over the selected period
- **Spending Chart** - Line chart of spending over time

### Generating Reports

Click **Generate** on any saved template. SOLUS will compile the data and present a **styled PDF preview** in-app. The preview matches SOLUS branding with your accent color and includes all selected sections with formatted tables and charts.

### Export Options

From the report preview, you have four export options:

| Option | Description |
|--------|-------------|
| **Download PDF** | Save the report as a styled PDF file to your computer |
| **Copy to Clipboard** | Copies a PNG screenshot of the report to your clipboard for quick pasting |
| **Export CSV** | Downloads raw report data as a CSV file for spreadsheet use |
| **Export JSON** | Downloads structured report data as JSON for programmatic use |

### Share to Discord

Click the **Share to Discord** button to send the report to your configured Discord webhook. The message includes:

- An embed with key stats fields (order count, stick rate, total spent, top item)
- A PNG screenshot of the full report as an attachment
- SOLUS branding in the embed footer

Configure your webhook in **Settings > Reports** before using this feature.

---

## Discord Integration

SOLUS integrates with Discord via webhooks to let you share order wins and reports with your group.

### Setup

1. Go to **Settings > Reports** tab
2. Paste your Discord webhook URL in the **Webhook URL** field
3. Both `discord.com` and `discordapp.com` webhook URLs are supported
4. Click **Test Webhook** to send a test message and verify the connection
5. Save your settings

### Two Ways to Share

#### Drop Flex

Share individual orders as a flex to your Discord channel.

1. Navigate to any retailer page
2. Find the order you want to share
3. Click the **Discord icon button** on the order card
4. An embed is sent to your webhook with:
   - Item name and image
   - Order amount
   - Order status
   - Retailer name
   - SOLUS logo

#### Report Share

Share full analytics reports with your group.

1. Generate a report from the Reports page
2. Click **Share to Discord**
3. An embed is sent with:
   - Order count
   - Stick rate
   - Total spent
   - Top item
   - PNG screenshot of the report as an attachment

### Embed Format

All Discord embeds follow a consistent format with:
- Purple accent color sidebar (or your configured accent color)
- SOLUS logo as the embed thumbnail
- Structured fields for key metrics
- Timestamp of when the share was sent

---

## Inventory Management

Track your inventory, costs, and profits.

### Portfolio Tab

#### Summary Cards
- **Market Value** - Current total value
- **Cost Basis** - What you paid
- **Profit/Loss** - Green when positive!
- **ROI %** - Return on investment
- **Item Count** - Total unique items

#### Adding Inventory

**Manual Add:**
1. Click **+ Add Item**
2. Enter SKU, name, quantity, cost per unit
3. Optionally set current market value
4. Click Save

**Import from Orders:**
1. Click **Import from Orders**
2. Select items from your synced orders
3. Items are added with order price as cost basis

#### Item Details
Click any item to see:
- Full product image
- Price history chart
- Cost vs. market value
- Associated orders
- Log Sale button

### Sales History Tab

Track items you've sold.

#### Summary
- Items Sold
- Total Revenue
- Total Cost Basis
- Realized P&L
- Average Margin %

#### Logging a Sale
1. Click **Log Sale** on any inventory item
2. Enter quantity sold
3. Enter sale price
4. Select platform (eBay, TCGPlayer, Mercari, Facebook, Local, Other)
5. Add date and optional notes
6. Click Save

Your profit is automatically calculated!

---

## TCG Price Tracker

Monitor TCGPlayer prices for your trading card inventory.

### Adding Items
1. Click **+ Add Item**
2. Paste a TCGPlayer URL or enter product details
3. Item is added and price fetched

### Price Monitoring

#### Auto-Refresh Options
| Interval | Best For |
|----------|----------|
| Manual Only | Occasional checking |
| Every 5-15 min | Active monitoring |
| Every 30-60 min | Regular tracking |
| Every 6 hours | Passive tracking |

#### Proxy Support
For heavy monitoring, set up proxies to avoid rate limits:
1. Click **Manage Proxies**
2. Create a new proxy list
3. Paste your proxies (one per line)
4. Select the list as active

### Price Display
Each item shows:
- Current market price
- Price trend indicator (up/down)
- Quantity held
- Last refresh time

---

## Settings

Configure SOLUS to work your way.

### General Tab

#### Preferences
- **Auto-sync on Launch** - Automatically sync recent emails when app starts
- **Light Mode** - Switch between dark and light themes
- **Flex PNG Folder** - Choose where to save flex screenshots

#### Accent Colors

Personalize the look of SOLUS by choosing an accent color in **Settings > General**.

**Preset Colors:**
- Purple (default)
- Blue
- Green
- Red
- Orange
- Pink

**Custom Color:** Enter any hex color code (e.g., `#FF6B35`) for a fully custom accent.

The accent color is applied across all UI elements including buttons, active states, chart colors, sidebar highlights, and Discord embed sidebars.

#### Sync Settings
- **Auto-Resume** - Automatically retry failed syncs (1-60 minutes, default: 1 min)

#### Walkthrough
- **Show Walkthrough** - Click this button to replay the 5-step onboarding tutorial at any time

### License Tab
View your license details:
- License key
- Plan type
- Status
- Expiration date
- Days remaining

Click **Disconnect License** to log out.

### Reports Tab

Configure report generation and Discord sharing.

- **Discord Webhook URL** - Paste your webhook URL for Discord integration
- **Test Webhook** - Send a test message to verify the connection
- **Report Templates** - Manage your saved report templates
- **PDF Export Settings** - Configure styling and layout preferences for generated PDFs

### Data Tab

#### Statistics
- Total Accounts
- Total Orders

#### Actions
- **Export** - Download your data as backup
- **Clear Orders** - Remove orders by timeframe (7, 14, 30, 60, 90 days or all)
- **Clear All Data** - Full reset (removes everything)

#### Dev Tools
- **Import EML** - Test email parsing with .eml files

### Jig Detection Tab

Group orders from jigged addresses together.

#### Built-in Patterns
Automatically decodes common leetspeak:
- `1` → `i`, `3` → `e`, `0` → `o`
- `@` or `4` → `a`, `$` or `5` → `s`
- `7` → `t`, `8` → `b`, `9` → `g`

#### Custom Patterns
Add your own substitutions:
```
Mainne=Main
Streeeet=Street
```

#### AYCD Expressions
Paste AYCD jig expressions:
```
%cMain,Maain,Mainn,Maiinn%
```

#### Manual Linking
Link addresses manually by dragging in Delivery Hub > By Address view.

---

## Tips & Tricks

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `/` | Jump to search (on retailer pages) |
| `Ctrl/Cmd + Click` | Multi-select drops |

### Best Practices

1. **Use App Passwords** - Never use your real email password. Create app-specific passwords for security.

2. **Sync Regularly** - Enable auto-sync on launch to keep data fresh.

3. **Set Auto-Resume** - For large mailboxes, set a 5-10 minute auto-resume to handle connection hiccups.

4. **Track Your Inventory** - Import orders to inventory to track true P&L.

5. **Use Jig Detection** - Enable it to see your real stick rate per address.

6. **Check Analytics Weekly** - Monitor trends to optimize your buying strategy.

7. **Use Discord Webhooks** - Share your wins and reports with your group. Set up a webhook in Settings > Reports and use the flex button on order cards or the share button on reports.

8. **Customize Your Dashboard** - Hide retailer cards you don't use and focus on the stores that matter to your workflow. Click the gear icon on the dashboard to toggle cards on and off.

9. **Use Report Templates** - Create templates for your weekly or monthly check-ins. Generate them with one click and share to Discord or export as PDF for record-keeping.

### Troubleshooting

**Sync not finding emails?**
- Check date range includes the order dates
- Try "Rescue from Spam" - emails might be filtered
- Verify app password is correct

**Orders showing wrong status?**
- Re-sync to pull latest updates
- Status updates depend on retailer email timing

**High cancellation rate?**
- Check Account Stats to identify problematic accounts/addresses
- Review jig detection settings
- Look at the Account Risk Score to surface high-risk accounts quickly

**Charts not loading?**
- Make sure the Analytics page has fully loaded before interacting with charts
- Try switching to a different tab and then switching back
- Check the DevTools console (Ctrl+Shift+I) for any error messages

---

## Support

Need help? Have feedback?

1. Go to **Settings > General**
2. Click **Send Feedback**
3. Describe your issue
4. Optionally include debug logs and screenshots
5. Add your Discord or email for follow-up

---

*SOLUS v2.0 - Built for resellers, by resellers.*
