// Frontend configuration for the search page.
// Fill these in with the values from your Supabase project:
//   - URL: Project Settings -> API -> Project URL
//   - Anon key: Project Settings -> API -> Project API keys -> "anon public"
//
// The anon key is safe to expose in the browser. The database only allows
// read access on the `messages` table thanks to Row-Level Security.
window.VN_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-ANON-PUBLIC-KEY",
  telegramChannel: "your_telegram_invite",
};
