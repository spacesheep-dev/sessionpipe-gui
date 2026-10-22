// SPDX-License-Identifier: Apache-2.0
// Owned by: phone-web. A QR code for a url, drawn in the page with the `qrcode` package the
// server already depends on (its browser build), so the phone page can show one for any
// address: the LAN url with the key, the trust page, the Tailscale name. `src` wins when
// the server serves the image itself.

import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function Qr({
  url,
  src,
  alt,
  size = 160,
}: {
  url: string | null;
  src?: string | null;
  alt: string;
  size?: number;
}) {
  const [made, setMade] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (src || !url) return;
    let on = true;
    QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => on && setMade(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => on && setMade(null));
    return () => {
      on = false;
    };
  }, [url, src]);
  const href = src ?? made;
  return (
    <div className="qr qr--phone">
      {href && !broken ? (
        <img src={href} alt={alt} width={size} height={size} onError={() => setBroken(true)} />
      ) : (
        <div className="qr-none" role="img" aria-label="QR code unavailable" style={{ width: size, height: size }}>
          <span>QR</span>
        </div>
      )}
    </div>
  );
}
