# Vehicle Service Logbook

A cloud workshop system for a vehicle service center. It runs as a static website (GitHub Pages) and stores its data in Firebase, so it works from any computer or phone.

- **Vehicle register:** plate, make, model, year, VIN/chassis, engine no., odometer, owner contact details and notes
- **Job cards:** numbered jobs (`JC-2611-001`) with work done, parts replaced or repaired, a 14-point inspection checklist, photos, labour, discount, tax and payments
- **Change log:** every edit to a job is recorded with who made it and when
- **Due for service:** vehicles that are overdue or coming due, with WhatsApp and copy-ready reminder messages
- **PDF invoices and job cards**, plus CSV export of the full history
- **Reports:** revenue by month, jobs by service type, technician workload, parts used, unpaid balances
- **Staff access:** sign in with Google; administrators add or remove staff by email

## Setup (about 15 minutes, free)

You need a Google account and a GitHub account. Firebase's free Spark plan is enough, so no card is required.

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project**. Give it a name (e.g. `service-logbook`). Google Analytics is not needed.
2. **Add a web app:** on the project home page click the **`</>`** (Web) icon, give it a nickname, and click **Register app**. Leave "Firebase Hosting" unticked.
3. Firebase shows a `firebaseConfig = { ... }` block. Copy those values into **`firebase-config.js`** in this repository, replacing the placeholders.

### 2. Turn on Google sign-in

**Build → Authentication → Get started → Sign-in method → Google → Enable**. Choose a support email, then **Save**.

### 3. Create the database

1. **Build → Firestore Database → Create database.** Pick the location closest to you (for Sri Lanka or India, `asia-south1` Mumbai). Start in **production mode**.
2. Open the **Rules** tab, delete what's there, paste the whole contents of **`firestore.rules`**, and click **Publish**.

### 4. Publish the site on GitHub Pages

1. In this GitHub repository open **Settings → Pages**.
2. Under **Build and deployment** choose **Deploy from a branch**, branch **`main`**, folder **`/ (root)`**, then **Save**.
3. After a minute the site is live at `https://<your-username>.github.io/<repository-name>/`.

### 5. Allow your site to sign in

In Firebase, open **Authentication → Settings → Authorized domains → Add domain** and enter `<your-username>.github.io`.

### 6. First sign-in

Open the site and sign in with Google. As the first person, you'll see **Set up this logbook**: click it to become the administrator. Then open **Settings**:

- Fill in your service center's name, phone, address, currency, tax and country calling code (used for invoices and WhatsApp links).
- Under **Staff access**, add each staff member's Google account email. They can then sign in at the same link.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app: layout, styles and logic |
| `firebase-adapter.js` | Connects the app to Firebase: sign-in, database, photos, downloads and staff access |
| `firebase-config.js` | Your Firebase project's settings (not secret; access is controlled by the rules) |
| `firestore.rules` | Database access rules, to paste into the Firebase console |

## Notes

- **Photos** are compressed (max 1280 px) and stored in Firestore, so you don't need Firebase Storage or a paid plan. The free plan holds 1 GB, which is several thousand photos.
- **Free plan limits** are 50,000 reads and 20,000 writes per day, far more than a single workshop uses.
- **PDF invoices** use the built-in PDF fonts, so non-Latin text (for example Sinhala or Tamil names) prints as `?`. The app itself shows all languages correctly.
- **Backups:** use **Export CSV** on the Jobs page regularly, or set up Firestore scheduled exports in the Google Cloud console.
