// Frontend configuration for the search page.
// Fill these in with the values from your Supabase project:
//   - URL: Project Settings -> API -> Project URL
//   - Anon key: Project Settings -> API -> Project API keys -> "anon public"
//
// The anon key is safe to expose in the browser. The database only allows
// read access on the `messages` table thanks to Row-Level Security.
window.VN_CONFIG = {
  // Project ref: wzopkceshvypksgpjzsx (VietNow)
  supabaseUrl: "https://wzopkceshvypksgpjzsx.supabase.co",
  // Paste the green "anon" "public" key you copied (Settings → API → Legacy keys):
  supabaseAnonKey: "YOUR-ANON-PUBLIC-KEY",
  telegramChannel: "your_telegram_invite",
};
