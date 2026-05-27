import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow HMR when opening the dev server via LAN IP (e.g. phone on same Wi‑Fi).
  // Update if your machine’s IP changes, or add another host from the terminal warning.
  allowedDevOrigins: ['192.168.3.18'],
};

export default nextConfig;
