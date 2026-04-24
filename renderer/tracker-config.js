// Shared between main.js (CommonJS) and renderer/app.js (plain <script>).
// Single source of truth for the tracker's Firebase project + event root.
const TRACKER_FB_ROOT = 'e3-kc26-x7k9m';
const TRACKER_FB_DATABASE_URL = 'https://kubecon-tracker-default-rtdb.europe-west1.firebasedatabase.app';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TRACKER_FB_ROOT, TRACKER_FB_DATABASE_URL };
}
if (typeof window !== 'undefined') {
  window.TRACKER_FB_ROOT = TRACKER_FB_ROOT;
  window.TRACKER_FB_DATABASE_URL = TRACKER_FB_DATABASE_URL;
}
