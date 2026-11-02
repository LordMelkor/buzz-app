import styles from "./ScrollEdgeMaterial.module.css";

/** Surface fade and progressive blur behind sticky chrome; its contents stay sharp. */
export function ScrollEdgeMaterial({
  edge,
  className,
}: {
  edge: "top" | "bottom";
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`${styles.root} ${className ?? ""}`}
      data-edge={edge}
    >
      <span />
      <span />
      <span />
    </div>
  );
}
