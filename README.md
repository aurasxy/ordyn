# Order Analytics Desktop App

A cross-platform desktop application for tracking orders from Walmart, Target, Pokemon Center, and Amazon.

## Quick Start

### 1. Install Dependencies
```bash
cd order-analytics-app
npm install
```

### 2. Generate License Keys (IMPORTANT - Do this first!)
```bash
node generate-keys.js 10
```
This creates `valid-licenses.json` - only keys in this file will work!

### 3. Run the App (Development)
```bash
npm start
```

### 4. Build Portable EXE (Windows)
```bash
npm run build:win
```
This creates: `dist/OrderAnalytics-1.0.0-portable.exe`

## License Key Management

### Generate Keys
```bash
node generate-keys.js 10        # Generate 10 PRO keys
node generate-keys.js 5 BETA    # Generate 5 BETA keys
```

### List All Keys
```bash
node generate-keys.js list
```

### Revoke a Key
```bash
node generate-keys.js revoke OA-PRO-XXXX-XXXX-XXXX
```

### How It Works
- Keys are stored in `valid-licenses.json`
- The app validates keys against this file
- Only pre-generated keys are accepted
- You control which keys are valid
- **KEEP THIS FILE SECURE** - don't share it with users!

## Security Notes

### What's Protected
- **ASAR packaging**: Code is bundled into an encrypted archive
- **License validation**: Only keys you generate will work
- **Key revocation**: You can disable any key anytime

### Distribution
1. Generate your license keys
2. Build the EXE: `npm run build:win`
3. Share only the EXE file (from `dist/` folder)
4. Give license keys to authorized users
5. Keep `generate-keys.js` and `valid-licenses.json` private!

### Files to KEEP PRIVATE (don't distribute):
- `generate-keys.js` - Key generator
- `valid-licenses.json` - Valid keys list
- `src/` folder - Source code

### Files to DISTRIBUTE:
- `dist/OrderAnalytics-1.0.0-portable.exe` - The app

## Features

- 🔐 License key activation (validated against your key list)
- ⚙️ Settings page with logout/disconnect option  
- 📧 Gmail IMAP email syncing
- 📊 Multi-retailer support (Walmart, Target, Pokemon Center)
- 📈 Order tracking & analytics
- 💾 Local data storage per user
- 📦 Single portable EXE file

## App Structure

```
order-analytics-app/
├── package.json
├── generate-keys.js      # YOUR KEY GENERATOR (keep private!)
├── valid-licenses.json   # VALID KEYS LIST (keep private!)
├── src/
│   ├── main.js          # Electron main process
│   ├── preload.js       # IPC bridge
│   └── index.html       # UI
├── assets/              # Icons (optional)
└── dist/                # Built EXE (distribute this)
```

## User Guide

### For Users
1. Run the EXE
2. Enter license key provided to you
3. Add Gmail account (with App Password)
4. Sync to pull orders

### Settings Page
- View license info
- Disconnect/logout
- Export data
- Clear all data

## Troubleshooting

### "Invalid or unrecognized license key"
- Make sure the key was generated with `generate-keys.js`
- Check that `valid-licenses.json` exists in the app directory
- Key may have been revoked

### IMAP sync failing?
1. Enable 2FA on Google account
2. Generate App Password: https://myaccount.google.com/apppasswords
3. Use App Password (not regular password)
4. Enable IMAP in Gmail settings
