// 作者社交渠道的单一来源：每个渠道的外链 href + 品牌图标路径（simple-icons，24×24 fill 单路径）。
// 文案标签不在此处——各页面按场景从 i18n 取（footer.social / sponsor.channels），
// 因为同一渠道在不同位置可能用不同措辞（如 footer 的「X」vs 赞助页的「X / Twitter」）。

interface SocialChannel {
  /** 外链地址；微信公众号无主页，直接指向频道二维码图。 */
  href: string;
  /** 24×24 fill 单路径，配合 <svg viewBox="0 0 24 24" fill="currentColor"> 渲染。 */
  icon: string;
}

export const SOCIAL = {
  blog: {
    href: 'https://blog.catcat.work',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  },
} as const satisfies Record<string, SocialChannel>;
