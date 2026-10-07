import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/**
 * Favicon generated at build time — one fewer binary in the repository and one
 * fewer thing to forget when the palette changes.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#2f6fed',
          color: 'white',
          fontSize: 20,
          fontWeight: 700,
          borderRadius: 6,
        }}
      >
        W
      </div>
    ),
    size
  );
}