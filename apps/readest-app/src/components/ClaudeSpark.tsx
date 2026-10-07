import clsx from 'clsx';
import React from 'react';

// Twelve rounded rays of uneven length, the "thinking" mark. Rotation and a
// slow breathe come from claude.css; e-ink and reduced motion hold it still.
const RAYS = [1, 0.72, 0.9, 0.66, 0.96, 0.7, 0.86, 0.64, 1, 0.74, 0.88, 0.68];

const ClaudeSpark: React.FC<{
  size?: number;
  still?: boolean;
  className?: string;
  label?: string;
}> = ({ size = 20, still = false, className, label }) => (
  <span
    className={clsx('claude-spark', className)}
    data-still={still ? 'true' : undefined}
    style={{ width: size, height: size }}
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    <svg viewBox='-12 -12 24 24' fill='none'>
      <g stroke='currentColor' strokeLinecap='round' strokeWidth='2.1'>
        {RAYS.map((length, i) => {
          const angle = (i * Math.PI * 2) / RAYS.length;
          const r0 = 1.6;
          const r1 = 1.6 + 8.6 * length;
          return (
            <line
              key={i}
              x1={(Math.cos(angle) * r0).toFixed(2)}
              y1={(Math.sin(angle) * r0).toFixed(2)}
              x2={(Math.cos(angle) * r1).toFixed(2)}
              y2={(Math.sin(angle) * r1).toFixed(2)}
            />
          );
        })}
      </g>
    </svg>
  </span>
);

export default ClaudeSpark;
