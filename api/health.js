export default async function handler(req, res) {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "YOUTUBE_REFRESH_TOKEN",
    "CRON_SECRET",
  ];
  const optional = ["OPENAI_API_KEY", "OPENAI_MODEL", "SETUP_SECRET", "STATUS_SECRET"];
  const present = Object.fromEntries([...required, ...optional].map((key) => [key, Boolean(process.env[key])]));

  return res.status(200).json({
    ok: required.every((key) => present[key]),
    required: Object.fromEntries(required.map((key) => [key, present[key]])),
    optional: Object.fromEntries(optional.map((key) => [key, present[key]])),
  });
}
