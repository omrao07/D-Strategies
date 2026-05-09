import type { ReactElement } from "react";

type AppProps = {
  Component: (props: any) => ReactElement;
  pageProps: Record<string, unknown>;
};

export default function App({
  Component,
  pageProps,
}: AppProps): ReactElement {
  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <Component {...pageProps} />
    </div>
  );
}