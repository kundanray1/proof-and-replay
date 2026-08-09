import { forwardRef } from "react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  SelectHTMLAttributes
} from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  leadingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "medium",
    busy = false,
    leadingIcon,
    disabled,
    type = "button",
    className = "",
    children,
    ...rest
  },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`button button--${variant} button--${size} ${className}`.trim()}
    >
      {leadingIcon ? <span className="button__icon" aria-hidden="true">{leadingIcon}</span> : null}
      <span>{children}</span>
    </button>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  compact?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, compact = false, className = "", children, ...rest },
  ref
) {
  return (
    <label className={`select-field ${compact ? "select-field--compact" : ""} ${className}`.trim()}>
      <span className="sr-only">{label}</span>
      <select ref={ref} aria-label={label} {...rest}>{children}</select>
    </label>
  );
});

export type BadgeTone = "neutral" | "live" | "success" | "danger" | "warning";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({ tone = "neutral", dot = false, className = "", children, ...rest }: BadgeProps): JSX.Element {
  return (
    <span {...rest} className={`badge badge--${tone} ${className}`.trim()}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Panel({ className = "", children, ...rest }: PanelProps): JSX.Element {
  return <section {...rest} className={`panel ${className}`.trim()}>{children}</section>;
}

export interface PanelHeaderProps {
  eyebrow: string;
  title: string;
  titleId?: string;
  action?: ReactNode;
}

export function PanelHeader({ eyebrow, title, titleId, action }: PanelHeaderProps): JSX.Element {
  return (
    <header className="panel-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={titleId}>{title}</h2>
      </div>
      {action}
    </header>
  );
}

export interface SegmentOption<TValue extends string> {
  value: TValue;
  label: string;
}

export interface SegmentedControlProps<TValue extends string> {
  label: string;
  value: TValue;
  options: readonly SegmentOption<TValue>[];
  onChange: (value: TValue) => void;
}

export function SegmentedControl<TValue extends string>({
  label,
  value,
  options,
  onChange
}: SegmentedControlProps<TValue>): JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={value === option.value ? "is-selected" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__mark" aria-hidden="true">P/R</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export interface PlayIconProps {
  size?: number;
}

export function PlayIcon({ size = 14 }: PlayIconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.75 3.4v9.2L12 8 4.75 3.4Z" fill="currentColor" />
    </svg>
  );
}
