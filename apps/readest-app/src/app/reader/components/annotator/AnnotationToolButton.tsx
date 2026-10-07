import clsx from 'clsx';
import React, { useState } from 'react';

interface AnnotationToolButtonProps {
  showTooltip: boolean;
  tooltipText: string;
  disabled?: boolean;
  Icon: React.ElementType;
  onClick: () => void;
  /** Stable DOM id. Android WebView exposes it as the node's resource id,
   * so UI automation can target the button without screen coordinates. */
  id?: string;
}

const AnnotationToolButton: React.FC<AnnotationToolButtonProps> = ({
  showTooltip,
  tooltipText,
  disabled,
  Icon,
  onClick,
  id,
}) => {
  const [buttonClicked, setButtonClicked] = useState(false);
  const handleClick = () => {
    setButtonClicked(true);
    onClick();
  };
  return (
    <div
      className='lg:tooltip lg:tooltip-bottom'
      title={!buttonClicked && showTooltip ? tooltipText : undefined}
    >
      <button
        id={id}
        onClick={handleClick}
        aria-label={tooltipText}
        className={clsx(
          'flex h-8 min-h-8 w-8 items-center justify-center p-0',
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'not-eink:hover:bg-base-content/8 eink:hover:border rounded-lg transition-colors',
        )}
        disabled={disabled}
      >
        <Icon />
      </button>
    </div>
  );
};

export default AnnotationToolButton;
