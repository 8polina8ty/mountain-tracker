import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const devAllowedOrigins =
  process.env.NODE_ENV === "production"
    ? []
    : [
        "*.trycloudflare.com",
        ...(process.env.DEV_TUNNEL_HOST
          ? [process.env.DEV_TUNNEL_HOST]
          : []),
      ];

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self)",
  },
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "upload.wikimedia.org",
        pathname: "/wikipedia/commons/**",
      },
      {
        protocol: "https",
        hostname: "upload.wikimedia.org",
        pathname: "/wikipedia/commons/thumb/**",
      },
      {
        protocol: "https",
        hostname: "weplpaigyyqzdkolypmw.supabase.co",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  ...(devAllowedOrigins.length > 0
    ? { allowedDevOrigins: devAllowedOrigins }
    : {}),
};

export default withNextIntl(nextConfig);
