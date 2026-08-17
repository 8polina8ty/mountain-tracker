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
  ...(devAllowedOrigins.length > 0
    ? { allowedDevOrigins: devAllowedOrigins }
    : {}),
};

export default withNextIntl(nextConfig);
