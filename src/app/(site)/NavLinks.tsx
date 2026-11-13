"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Main navigation links; the current page is marked with aria-current (styled as underlined). */
export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <>
      {items.map((n) => (
        <li key={n.href}>
          <Link href={n.href} aria-current={path === n.href ? "page" : undefined}>{n.label}</Link>
        </li>
      ))}
    </>
  );
}
