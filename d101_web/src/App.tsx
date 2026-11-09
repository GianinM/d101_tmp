import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SwissMap } from "@/components/swiss-map"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function App() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <main className="flex min-h-0 flex-1 flex-col">
          <SwissMap className="flex-1 overflow-hidden rounded-b-xl" />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
