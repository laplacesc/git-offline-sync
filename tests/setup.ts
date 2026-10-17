// jsdom 不实现 Web Animations；真实浏览器仍使用 HeroUI 的原生动画。
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
