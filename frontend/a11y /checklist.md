# Accessibility Checklist

*A practical WCAG 2.1 (A & AA) audit list for developers & designers.*

---

## 🎨 Visual Design & Color

- [ ] Text and interactive elements meet minimum **contrast ratio** (4.5:1 normal text, 3:1 large text).  
- [ ] Color is **not the only means** of conveying information.  
- [ ] Focus indicators are clearly visible.  
- [ ] No text is embedded inside images (unless decorative with alt text).  

---

## ⌨️ Keyboard Navigation

- [ ] All functionality is accessible via **keyboard only**.  
- [ ] Tabbing order is logical and predictable.  
- [ ] Interactive elements can be activated with **Enter/Space**.  
- [ ] Skip-to-content link is available for bypassing navigation.  

---

## 🧭 Structure & Semantics

- [ ] Pages use proper **headings (h1–h6)** in logical order.  
- [ ] Page regions are defined using semantic landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`).  
- [ ] Lists (`<ul>`, `<ol>`) and tables (`<table>`) use correct semantic markup.  
- [ ] Decorative elements are hidden from assistive tech (`aria-hidden="true"`).  

---

## 📋 Forms

- [ ] Every input has an **associated label** (`<label>` or `aria-label`).  
- [ ] Groups of controls use `<fieldset>` and `<legend>`.  
- [ ] Required fields are indicated with both **visual cues and programmatic attributes** (`required`, `aria-required`).  
- [ ] Error messages are descriptive and associated with fields (`aria-describedby`).  

---

## 🎧 Screen Reader Support

- [ ] All images have meaningful **alt text** or empty alt (`alt=""`) if decorative.  
- [ ] ARIA roles are used only when semantic HTML is insufficient.  
- [ ] Live regions announce dynamic content updates (`aria-live`).  
- [ ] Page titles are descriptive and unique.  

---

## 📱 Responsive & Mobile

- [ ] Layout works at multiple screen sizes without loss of functionality.  
- [ ] Touch targets are at least **44x44px**.  
- [ ] No reliance on hover-only interactions.  

---

## 🛠️ Testing

- [ ] Automated checks with tools like **axe**, **Lighthouse**, or **Pa11y**.  
- [ ] Manual keyboard testing for all key flows.  
- [ ] Screen reader testing (NVDA, VoiceOver, or JAWS).  
- [ ] Color-blindness and zoom testing (up to 200%).  

---

## ✅ Final Verification

- [ ] Meets **WCAG 2.1 Level A & AA** success criteria.  
- [ ] No accessibility-blocking issues remain.  
- [ ] Accessibility checks integrated into CI/CD pipeline.  

---

**References**  

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)  
- [WAI-ARIA Practices](https://www.w3.org/WAI/ARIA/apg/)  
- [WebAIM Checklist](https://webaim.org/standards/wcag/checklist)  
