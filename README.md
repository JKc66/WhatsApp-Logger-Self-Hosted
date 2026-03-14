# WhatsApp Logger (Self-Hosted)

A privacy-focused, self-hosted WhatsApp archiving tool. It captures messages (including deleted ones) via a linked device connection and stores them in your own Firebase Firestore database.

### Check <a href="https://amit.is-a.dev/logger">guide</a> for detailed installation process.

### Important notes:
 * It is recommended to download the **web app** after the publication of webpage for better security. 
 * It is recommended to use **PIN** or **Biometric authentication** inside web app. Find the authentication options in Settings

## 🚀 Features

* **Anti-Delete**: Logs messages instantly, preserving them even if the sender deletes them.
* **Privacy First**: You host the backend and database. No third-party servers access your data.
* **Secure Access**: Frontend is protected by a password validated against your backend.
* **Media Support**: Captures text messages (Images/Media support depends on Baileys implementation, primarily text-focused).
* **Search & Filter**: Search by content or filter by date.
* **Export**: Export chat logs to `.txt` files.

---

## 🛠️ Prerequisities

1.  A **GitHub** Account.
2.  A **Render** Account (Free tier works) **— or — a Linux VM** (e.g., DigitalOcean, Hetzner, AWS EC2).
3.  A **Firebase** Account (Free Spark plan works).
4.  A **WhatsApp** account on your phone.
5.  An **UptimeRobot** Account (Free) — only needed for the Render deployment option.

---

##  step 1: Firebase Setup (The Database)

1.  Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project.
2.  **Create Database**:
    * Navigate to **Firestore Database** in the sidebar.
    * Click **Create Database**.
    * Select a location (e.g., `nam5` or `eur3`).
    * Start in **Production Mode**.
3.  **Set Security Rules**:
    * Go to the **Rules** tab in Firestore.
    * Replace the rules with the following (allows anyone to read, but only backend with Admin SDK can write):
        ```javascript
         rules_version = '2';
         service cloud.firestore {
           match /databases/{database}/documents {
             match /{document=**} {
               // 1. Allow Read: Essential for your HTML page to fetch chats.
               allow read: if true;
         
               // 2. Allow Update: Enables the "Rename Chat" feature from the frontend.
               // This allows updating existing documents (like changing the name)
               // but prevents creating NEW documents or Deleting them.
               allow update: if true;
         
               // 3. Block Create/Delete: Only the Backend (Render) can create new messages
               // or delete them. This prevents random people from injecting fake chats.
               allow create, delete: if false;
             }
           }
         }
        ```
4.  **Get Backend Credentials (Service Account)**:
    * Go to **Project Settings** (Gear icon) -> **Service accounts**.
    * Click **Generate new private key**.
    * This will download a `.json` file. **Keep this safe.** You will need its content for Render.
5.  **Get Frontend Configuration**:
    * Go to **Project Settings** -> **General**.
    * Scroll down to "Your apps" and click the **Web (</>)** icon.
    * Register app (nickname: "Logger Frontend").
    * Copy the `firebaseConfig` object (API Key, Project ID, etc.). You will need this for `index.html`.

---

## Step 2: Deploy Backend (The Listener)

> **Choose one** of the two deployment options below.

### Option A: Deploy on Render (Cloud — easy, free tier available)

1.  **Fork this Repository** to your own GitHub account.
2.  Log in to [Render](https://render.com/).
3.  Click **New +** -> **Web Service**.
4.  Connect your forked repository.
5.  **Runtime**: Select **Docker**.
6.  **Environment Variables** (Critical Step):
    Add the following variables under "Advanced":
    * `FIREBASE_SERVICE_ACCOUNT`: Paste the **entire content** of the JSON file you downloaded in Step 1.
    * `AUTH_USER`: Set a username (e.g., `admin`).
    * `AUTH_PASS`: Set a strong password. This creates the lock for your logger.
    * *(Optional)* `WHATSAPP_PHONE_NUMBER`: Your WhatsApp number with country code, digits only (e.g., `15551234567`). If set, a pairing code is automatically generated on startup instead of a QR code.
7.  Click **Create Web Service**.
8.  Wait for the deployment to finish. Render will give you a URL like `https://your-app.onrender.com`.

### Option B: Deploy on a Virtual Machine (VPS/VM — full control)

Use this if you have a Linux VM (Ubuntu/Debian) from any provider (DigitalOcean, AWS EC2, Hetzner, etc.).

1.  **Connect to your VM** via SSH.

2.  **Install Bun** (the JavaScript runtime used by this project):
    ```bash
    curl -fsSL https://bun.sh/install | bash
    source ~/.bashrc   # or open a new terminal session
    bun --version      # verify installation
    ```

3.  *(Optional)* **Install Docker** if you want to run the app as a container:
    ```bash
    # Docker install (Ubuntu)
    sudo apt-get update
    sudo apt-get install -y docker.io
    sudo systemctl enable --now docker
    ```
    > **Note:** Docker is not required. Steps 6–8 below show how to run the app **directly with Bun** (no Docker needed), which is simpler for most VM deployments.

4.  **Clone your forked repository**:
    ```bash
    git clone https://github.com/YOUR_USERNAME/WhatsApp-Logger-Self-Hosted.git
    cd WhatsApp-Logger-Self-Hosted
    ```

5.  **Create an environment file** (`.env`) in the project directory:
    ```bash
    cat > .env << 'EOF'
    FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}   # paste JSON here
    AUTH_USER=admin
    AUTH_PASS=yourStrongPassword
    WHATSAPP_PHONE_NUMBER=15551234567   # optional, for phone pairing
    PORT=3000
    EOF
    ```

6.  **Run directly with Bun** (no Docker needed):
    ```bash
    bun install
    # Load env vars and start:
    set -a && source .env && set +a
    bun run index.js
    ```

7.  **Keep it running with PM2** (recommended for production):
    ```bash
    # Install PM2
    bun add -g pm2

    # Start the app and persist across reboots
    pm2 start index.js --name whatsapp-logger --interpreter bun
    pm2 save
    pm2 startup   # follow the printed command to enable auto-start
    ```

    Useful PM2 commands:
    ```bash
    pm2 logs whatsapp-logger   # view logs
    pm2 restart whatsapp-logger
    pm2 stop whatsapp-logger
    ```

8.  **Or run as a systemd service**:

    > Replace `YOUR_USER` below with your actual Linux username (check with `whoami`).

    ```bash
    sudo tee /etc/systemd/system/whatsapp-logger.service > /dev/null << EOF
    [Unit]
    Description=WhatsApp Logger
    After=network.target

    [Service]
    WorkingDirectory=/home/YOUR_USER/WhatsApp-Logger-Self-Hosted
    EnvironmentFile=/home/YOUR_USER/WhatsApp-Logger-Self-Hosted/.env
    ExecStart=/home/YOUR_USER/.bun/bin/bun run index.js
    Restart=always
    User=YOUR_USER

    [Install]
    WantedBy=multi-user.target
    EOF

    sudo systemctl daemon-reload
    sudo systemctl enable --now whatsapp-logger
    sudo systemctl status whatsapp-logger
    ```

9.  **Open port 3000** (or whatever `PORT` you set) in your VM's firewall / security group.
    Then visit `http://YOUR_VM_IP:3000` in a browser to complete the WhatsApp linking step.

---

## Step 3: Connect WhatsApp

1.  Open your backend URL in a browser (e.g., `https://your-app.onrender.com` or `http://YOUR_VM_IP:3000`).
2.  You will be prompted for a login. Use the `AUTH_USER` and `AUTH_PASS` you configured.
3.  **Two pairing options are available:**

    **Option A – QR Code (default)**
    * You will see a **QR Code** on the page.
    * Open **WhatsApp** on your phone: iOS → Settings → Linked Devices | Android → Three dots → Linked Devices.
    * Tap **Link a Device** and scan the QR code.

    **Option B – Phone Number Pairing Code**
    * Either set the `WHATSAPP_PHONE_NUMBER` environment variable (digits only, e.g., `15551234567`) before starting — the backend will automatically request a code on startup.
    * Or, on the QR code page, scroll down and enter your phone number in the **"Get Code"** form.
    * A short alphanumeric code (e.g., `ABCD-EFGH`) will be displayed.
    * Open **WhatsApp** → Linked Devices → **Link with phone number**, and enter the code.

4.  The page should refresh and say **"System Operational"**. Your backend is now listening!

---

## Step 4: Setup Frontend (The Viewer)

1.  Download the `index.html` file from this repository.
2.  Open `index.html` in a text editor (Notepad, VS Code, etc.).
3.  Locate the Configuration section (around line 675).
4.  **Fill in the details**:
    * `RENDER_BACKEND_URL`: Your backend URL (e.g., `https://your-app.onrender.com` or `http://YOUR_VM_IP:3000` - **No trailing slash**).
    * `firebaseConfig`: The keys you copied in Step 1.5.

    **It should look like this before you edit it:**
    ```javascript
    const RENDER_BACKEND_URL = ""; 

    // Firebase Config
    const firebaseConfig = {
        apiKey: "",
        authDomain: "",
        projectId: "",
        storageBucket: "",
        messagingSenderId: "",
        appId: ""
    };
    ```

5.  **Deploy the Frontend**:
    * You can host this single file anywhere:
        * **Firebase Hosting** (Recommended): `firebase init` -> Hosting -> Select `public` directory -> Put `index.html` there -> `firebase deploy`.
        * **GitHub Pages**: Enable Pages in your repo settings.
        * **Netlify/Vercel**: Drag and drop the folder containing `index.html`.

---

## Step 5: Usage

1.  Navigate to your hosted frontend URL (e.g., `https://amit.is-a.dev/wp-chat`).
2.  You will see a Login Screen.
3.  Enter the same `AUTH_USER` and `AUTH_PASS` you configured on your backend (Render or VM).
4.  Once unlocked, your chats will load from Firebase.
    * **Sidebar**: Shows chat list sorted by newest activity.
    * **Search**: Filter contacts by name or phone number.
    * **Export**: Download chat history as a `.txt` file.

---

## Step 6: Keep it Alive (UptimeRobot — Render only)

Render's free tier spins down after inactivity. If you deployed on Render, use UptimeRobot to keep it running 24/7.
(If you deployed on a VM, PM2 or systemd already keeps it running — skip this step.)

1.  Create a free account on [UptimeRobot](https://uptimerobot.com/).
2.  Click **Add New Monitor**.
3.  **Monitor Type**: HTTP(s).
4.  **Friendly Name**: WhatsApp Logger.
5.  **URL (or IP)**: `https://your-app.onrender.com/ping` (Make sure to add `/ping` at the end).
6.  **Monitoring Interval**: 5 minutes.
7.  Click **Create Monitor**.

---

## Troubleshooting

* **"No chats found"**: Send a message to the linked WhatsApp account to trigger the first log.
* **"Incorrect Credentials"**: Ensure your Render backend is running and you are using the exact Username/Password defined in Render Environment Variables.
* **Proof/Phone Numbers**: If a chat shows a long ID (e.g., `1155...@lid`), wait a few minutes. The backend automatically syncs contacts and updates the record with the real phone number.

## Disclaimer

This tool is for personal archiving purposes. Using it to log conversations without consent may violate privacy laws in your jurisdiction. The author is not responsible for misuse.
