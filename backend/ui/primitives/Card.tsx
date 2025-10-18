// primitives/card.tsx
import type { FC, ReactNode, CSSProperties, ElementType } from "react";

export interface CardProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  padded?: boolean;
  shadow?: "none" | "sm" | "md" | "lg" | "xl";
  border?: boolean;
  rounded?: boolean;
  as?: ElementType; // ✅ string tag ("div") or custom React component
}

const shadowMap: Record<NonNullable<CardProps["shadow"]>, string> = {
  none: "none",
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
  xl: "var(--shadow-xl)",
};

export const Card: FC<CardProps> = ({
  children,
  className = "",
  style,
  padded = true,
  shadow = "md",
  border = true,
  rounded = true,
  as: Tag = "div",
}) => {
  const styles: CSSProperties = {
    background: "var(--surface)",
    color: "var(--text)",
    border: border ? "1px solid var(--border)" : "none",
    borderRadius: rounded ? "var(--radius-2xl)" : "0px",
    boxShadow: shadowMap[shadow],
    padding: padded ? "var(--space-4)" : undefined,
    ...style,
  };

  return (
    <Tag className={className} style={styles}>
      {children}
    </Tag>
  );
};

// ---------- Subcomponents ----------
export const CardHeader: FC<{ children?: ReactNode; className?: string; style?: CSSProperties; as?: ElementType }> = ({
  children,
  className = "",
  style,
  as: Tag = "div",
}) => (
  <Tag
    className={className}
    style={{
      marginBottom: "var(--space-2)",
      fontWeight: "var(--weight-semibold)",
      fontSize: "var(--text-lg)",
      ...style,
    }}
  >
    {children}
  </Tag>
);

export const CardBody: FC<{ children?: ReactNode; className?: string; style?: CSSProperties; as?: ElementType }> = ({
  children,
  className = "",
  style,
  as: Tag = "div",
}) => (
  <Tag
    className={className}
    style={{
      flex: "1 1 auto",
      fontSize: "var(--text-sm)",
      lineHeight: "var(--leading-normal)",
      ...style,
    }}
  >
    {children}
  </Tag>
);

export const CardFooter: FC<{ children?: ReactNode; className?: string; style?: CSSProperties; as?: ElementType }> = ({
  children,
  className = "",
  style,
  as: Tag = "div",
}) => (
  <Tag
    className={className}
    style={{
      marginTop: "var(--space-3)",
      fontSize: "var(--text-sm)",
      color: "var(--text-muted)",
      ...style,
    }}
  >
    {children}
  </Tag>
);

export default Card;
