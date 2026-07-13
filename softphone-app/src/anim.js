import { gsap } from 'gsap';

// Entrada suave (fade + leve slide/scale). Se usa como callback ref: ref={gEnter}
export const gEnter = (el) => {
  if (!el) return;
  gsap.fromTo(el, { opacity: 0, y: 16, scale: 0.99 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out', clearProps: 'transform' });
};

// Pop con rebote (avatares, check de éxito). Callback ref: ref={gPop}
export const gPop = (el) => {
  if (!el) return;
  gsap.fromTo(el, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: 'back.out(1.8)', clearProps: 'transform' });
};

// Timeline del splash. Devuelve cleanup (revierte). Usar con un ref al contenedor.
export const gSplash = (root) => {
  if (!root) return () => {};
  const ctx = gsap.context(() => {
    const tl = gsap.timeline();
    tl.from('.sp-badge', { scale: 0.3, opacity: 0, rotate: -18, duration: 0.7, ease: 'back.out(1.9)' })
      .from('.sp-title', { y: 16, opacity: 0, duration: 0.5, ease: 'power3.out' }, '-=0.25')
      .from('.sp-ver', { opacity: 0, duration: 0.4 }, '-=0.2');
  }, root);
  return () => ctx.revert();
};

// Apertura de modal estilo "pretty-modal": escala elástica + blur (callback ref)
export const gModal = (el) => {
  if (!el) return;
  gsap.fromTo(el, { scale: 0.82, opacity: 0, filter: 'blur(10px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 0.55, ease: 'elastic.out(1, 0.72)', clearProps: 'filter,transform,opacity' });
};

// Entrada escalonada de los hijos (botonera de llamada). Callback ref.
export const gStagger = (el) => {
  if (!el) return;
  gsap.from(el.children, { y: 14, opacity: 0, duration: 0.4, stagger: 0.045, ease: 'power3.out', clearProps: 'transform,opacity' });
};
