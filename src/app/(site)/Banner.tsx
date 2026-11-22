import Image, { type StaticImageData } from "next/image";
import site from "./site.module.css";

/**
 * The picture band at the top of a page: one photograph across the full width, under a flat layer
 * of ink so the white headline on it stays readable. The children are the headline (give it the
 * same id) and whatever sits under it. The equipment is on the right of each photograph and the
 * left is left dark for the text.
 */
export function Banner({ id, photo, small = false, children }: { id: string; photo: StaticImageData; small?: boolean; children: React.ReactNode }) {
  return (
    <section className={small ? `${site.banner} ${site.bannerSmall}` : site.banner} aria-labelledby={id}>
      <Image className={site.bannerPhoto} src={photo} alt="" fill sizes="100vw" preload placeholder="blur" />
      <div className={`${site.container} ${site.bannerInner}`}>
        <div className={site.bannerText}>{children}</div>
      </div>
    </section>
  );
}
