import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AnalyticsIcon,
  CampaignsIcon,
  ConversationsIcon,
  LogoMark,
} from "@/components/ui/icons";

const FEATURES = [
  {
    title: "Find your next customers",
    description:
      "Discover and qualify leads that match your business, without manual prospecting.",
    icon: CampaignsIcon,
  },
  {
    title: "Talk to every lead",
    description:
      "Keep every conversation with a prospect organized in one shared inbox.",
    icon: ConversationsIcon,
  },
  {
    title: "See what's working",
    description:
      "Track campaigns and deals end to end, so you know where to focus next.",
    icon: AnalyticsIcon,
  },
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark className="h-7 w-7" />
            <span className="text-sm font-semibold text-slate-900">
              Business Badhao
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Log in
            </Link>
            <Link href="/signup">
              <Button>Get started</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Grow your business with AI-powered customer acquisition
            </h1>
            <p className="mt-6 text-lg text-slate-600">
              Business Badhao helps small and growing businesses find leads,
              run outreach, and close deals, all from a single workspace.
            </p>
            <div className="mt-10 flex items-center justify-center gap-4">
              <Link href="/signup">
                <Button className="px-6 py-3 text-base">Get started</Button>
              </Link>
              <Link href="/login">
                <Button variant="secondary" className="px-6 py-3 text-base">
                  Log in
                </Button>
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              {FEATURES.map((feature) => (
                <Card key={feature.title} className="p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
                    <feature.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-slate-900">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm text-slate-600">
                    {feature.description}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-500 sm:px-6 lg:px-8">
          © {new Date().getFullYear()} Business Badhao. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
