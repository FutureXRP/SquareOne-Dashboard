import React, { useState } from "react";
import { brand } from "./brand.js";

/*
  Renders the building's logo from public/brand-logo.svg (then .png), falling
  back to a simple square if neither file exists. Drop the real logo at
  public/brand-logo.svg and it appears everywhere automatically.
*/
export function BrandLogo({ size = 32, fallbackColor = "#52BECF" }) {
  const [src, setSrc] = useState(brand.logoSrc);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <div style={{ width: size, height: size, border: `2px solid ${fallbackColor}`, borderRadius: 5, flexShrink: 0 }} />;
  }
  return (
    <img
      src={src}
      alt={brand.org}
      onError={() => (src !== brand.logoFallbackSrc ? setSrc(brand.logoFallbackSrc) : setFailed(true))}
      style={{ height: size, width: "auto", maxWidth: 200, objectFit: "contain", display: "block", flexShrink: 0 }}
    />
  );
}
