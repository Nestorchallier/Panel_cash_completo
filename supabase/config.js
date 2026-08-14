// Config pública de Supabase para Panel Cash Market.
// La "publishable key" está diseñada para vivir en el cliente (frontend);
// el acceso real a los datos lo controla Row Level Security en cada tabla
// (ver schema.sql), no el secreto de esta key. Nunca pongas acá la
// service_role key — esa sí es secreta y nunca debe subirse al repo.

const SUPABASE_URL = 'https://ilcffrwwltpxxptspktv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_LnUHDSBAdIH4oiR3oi-eww_zwu0ePxx';
