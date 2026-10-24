import { useEffect } from "react";
import { Bar } from "./Frame";
import { initScroll, watchFrame, watchReveals } from "./engine";
import { Finale, Footer, Gets, Hero, NotFound, Price, Room } from "./sections";
import AppPage from "./app/AppPage";
import { Burns } from "./Burns";
import { Toaster } from "./app/toast";

function Home() {
  useEffect(() => {
    initScroll();
    const a = watchReveals();
    const b = watchFrame();
    return () => (a(), b());
  }, []);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Bar here="home" />
      <main id="main">
        <Hero />
        <Gets />
        <Room />
        <Price />
        <Finale />
      </main>
      <Footer />
    </>
  );
}

function Page({ path }: { path: string }) {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return <Home />;
  if (p === "/app") return <AppPage />;
  if (p === "/burns") return <Burns />;
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Bar here="app" />
      <NotFound />
    </>
  );
}

export function App({ path }: { path: string }) {
  return (
    <>
      <Page path={path} />
      <Toaster />
    </>
  );
}
