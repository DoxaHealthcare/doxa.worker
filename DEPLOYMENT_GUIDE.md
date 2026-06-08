# Automated Deployment Guide (GitHub Actions + DigitalOcean + PM2) - Worker Service

This guide summarizes the setup for a production-ready CI/CD pipeline for the Doxa Worker service on a resource-constrained server.

## 1. GitHub Secrets Setup
Add these to your repository under **Settings > Secrets and variables > Actions**:

| Secret Name | Description | Example Value |
| :--- | :--- | :--- |
| `SSH_HOST` | Server IP Address | `137.184.222.44` |
| `SSH_USER` | SSH Username | `root` |
| `SSH_KEY` | **Private** SSH Key | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `DEPLOY_PATH` | Project path on server | `/root/doxa.worker` |
| `SSH_PORT` | SSH Port (default 22) | `22` |
| `DISCORD_WEBHOOK_ID` | Discord Webhook ID | `1513543060619919512` |
| `DISCORD_WEBHOOK_TOKEN` | Discord Webhook Token | `dCKWoAogsyfm153iq8eRFdneXKn2V7PbtaJeKD51T2fogsZhP_GQxp9MHpvstdkWCu5V` |

---

## 2. Server-Side Preparation
Run these commands on your DigitalOcean droplet once:

```bash
# Install global dependencies
npm install -g pm2 yarn

# Setup SSH Authorization (Paste your LOCAL .pub key)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAAC3NzaC...your_public_key... user@local" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Initial project setup
git clone git@github.com:CanonSamson/doxa.worker.git /root/doxa.worker
cd /root/doxa.worker
touch .env # Manually add your environment variables here (e.g., DISTOKEN, PORT, etc.)
```

---

## 3. GitHub Actions Workflow
Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Worker to DigitalOcean

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT || 22 }}
          script: |
            # Load Node environment (NVM)
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
            
            # Deployment steps
            cd ${{ secrets.DEPLOY_PATH }}
            git pull origin main
            yarn install
            yarn build
            pm2 restart doxa-worker || pm2 start ecosystem.config.cjs
```

---

## 4. PM2 Configuration (Low RAM Optimization)
Create `ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [
    {
      name: 'doxa-worker',
      script: './dist/src/index.js',
      instances: 1,         // Single instance for low RAM
      exec_mode: 'fork',    // Fork mode instead of Cluster
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

---

## 5. TypeScript Memory Fix
If your server has < 1GB RAM, update `package.json` to prevent `tsc` from crashing during build (the current default is 1536MB, which might be too high for a 512MB server):

```json
"scripts": {
  "build": "node --max-old-space-size=400 ./node_modules/.bin/tsc && ..."
}
```

---

## 6. Maintenance Commands
- **View Logs**: `pm2 logs doxa-worker`
- **Check Status**: `pm2 list`
- **Kill Stuck Port**: `fuser -k 4001/tcp` (if you get EADDRINUSE)
- **Save List**: `pm2 save` (to persist across reboots)
