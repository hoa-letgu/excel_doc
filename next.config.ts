import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Accessed via LAN IP, not localhost — without this, Next's dev server
  // blocks its own dev resources (HMR socket, possibly static chunks) as
  // cross-origin, which is why the page hung forever on "Đang tải ứng dụng...".
  allowedDevOrigins: ["10.30.21.75"],
};

export default nextConfig;
