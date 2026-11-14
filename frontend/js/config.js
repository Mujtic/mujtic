// Mujtic — backend API configuration.
// TODO: update the hostname once the backend is redeployed under the Mujtic
// brand (e.g. https://mujtic.onrender.com/api or your custom domain). While it
// points at the old Glycr service, everything keeps working — the URL is just
// the internal render.com hostname and isn't shown to users.

window.MUJTIC_CONFIG = {
  apiBase: 'https://glycr.onrender.com/api',                // keep whatever you already have
  mapsApiKey: 'PASTE_YOUR_KEY_HERE',
};