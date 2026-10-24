import { useEffect, useRef } from "react";
import { chapters, finale, footer, gets, hero, price, room, site, stations } from "./data/site";
import { startWorkshop } from "./motion/workshop";
import { sceneMarkup } from "./motion/scene";
import { Mark } from "./Frame";

const SCENE = sceneMarkup();

export function Hero() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => startWorkshop(ref.current!), []);
  return (
    <section className="hero" id="top" ref={ref}>
      <div className="stage">
        <svg className="scene" aria-hidden="true" dangerouslySetInnerHTML={{ __html: SCENE }} />
        <div className="vignette" aria-hidden="true" />

        <div className="intro" data-intro>
          <h1>
            {hero.h1.map((l) => (
              <span key={l} className="ln">
                {l}{" "}
              </span>
            ))}
          </h1>
          <p className="lede">{hero.lede}</p>
          <div className="actions" data-actions>
            <a className="btn" href="/app">
              <span>{hero.cta}</span>
            </a>
            <a className="u" href="#gets">
              {hero.link}
            </a>
          </div>
        </div>

        <div className="caps">
          <ol className="stepper" aria-label="How an agent is built">
            {stations.map((s) => (
              <li key={s} data-step>
                {s}
              </li>
            ))}
          </ol>
          <div className="cap-stack">
            {chapters.map((c) => (
              <article key={c.n} className="cap" data-cap data-from={c.from} data-to={c.to}>
                <span className="num">{c.n}</span>
                <h2>{c.title}</h2>
                <p>{c.body}</p>
              </article>
            ))}
          </div>
        </div>

        <p className="meter" aria-hidden="true">
          <span>Tokens</span>
          <b data-count>0 / 5</b>
        </p>
        <p className="cue" aria-hidden="true">
          Scroll to build it
        </p>
      </div>
    </section>
  );
}

export function Gets() {
  return (
    <section className="gets" id="gets">
      <div className="grid12">
        <h2 className="display" data-rv>
          {gets.title}
        </h2>
        <dl className="ledger">
          {gets.rows.map((r, i) => (
            <div key={r.k} className="lrow" data-rv style={{ transitionDelay: `${i * 50}ms` }}>
              <dt>{r.k}</dt>
              <dd>{r.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Room() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => startWorkshop(ref.current!, { fixed: 1 }), []);
  return (
    <section className="room" id="room">
      <div className="grid12">
        <div className="r-copy">
          <h2 className="display" data-rv>
            {room.title}
          </h2>
          <p className="lede" data-rv>
            {room.lede}
          </p>
          <dl className="rules">
            {room.rules.map((r, i) => (
              <div key={r.k} data-rv style={{ transitionDelay: `${i * 60}ms` }}>
                <dt>{r.k}</dt>
                <dd>{r.v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="r-fig" ref={ref} aria-hidden="true">
          <svg className="scene" dangerouslySetInnerHTML={{ __html: SCENE }} />
        </div>
      </div>
    </section>
  );
}

export function Price() {
  return (
    <section className="price" id="price">
      <div className="grid12">
        <div className="p-head">
          <h2 className="display" data-rv>
            {price.title}
          </h2>
          <p className="lede" data-rv>
            {price.lede}
          </p>
          <p className="big-n" data-rv>
            <b>{site.perToken.toLocaleString("en-US")}</b> <span>{price.perLabel}</span>
          </p>
        </div>
        <table className="ptable" data-rv>
          <caption className="sr">Cost of training by number of tokens</caption>
          <thead>
            <tr>
              <th scope="col">Tokens</th>
              <th scope="col">You have burned</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {price.rows.map((r) => (
              <tr key={r.n} className={r.n === site.minTokens ? "is-min" : ""}>
                <th scope="row">{r.n}</th>
                <td>{r.total}</td>
                <td className="pn">{r.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="p-foot">{price.foot} <a className="u" href="/burns">Fees and burns</a></p>
      </div>
    </section>
  );
}

export function Finale() {
  return (
    <section className="finale">
      <div className="grid12">
        <h2 className="display" data-rv>
          {finale.title}
        </h2>
        <a className="btn" href="/app" data-rv>
          <span>{finale.cta}</span>
        </a>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="grid12">
        <p className="fine">{footer.fine}</p>
        <nav className="f-links" aria-label="Footer">
          <a className="u" href="#top">
            Back to the top
          </a>
          <a className="u" href="/burns">
            Fees and burns
          </a>
          <a className="u" href="/app">
            Create an agent
          </a>
        </nav>
      </div>
      <a className="wm" href="#top" aria-label={`${site.name}, back to top`}>
        <span>{site.name.toLowerCase()}</span>
      </a>
      <p className="legal">
        <Mark size={16} /> {site.name} · {site.year}
      </p>
    </footer>
  );
}

export function NotFound() {
  return (
    <main id="main" className="nf">
      <p className="nf-code">404</p>
      <h1>This room does not exist.</h1>
      <p>Nothing is stored at this address, and nothing was recorded about the visit.</p>
      <a className="btn" href="/">
        <span>Back to the workshop</span>
      </a>
    </main>
  );
}
