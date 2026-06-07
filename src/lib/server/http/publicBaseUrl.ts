export function getPublicBaseUrl() {
  const configured = process.env.KIKI_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) return `https://${railwayDomain}`;
  return "http://localhost:3000";
}
