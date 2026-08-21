import { NextResponse } from "next/server";

import { getProjectAccessRole } from "@/Lib/projects/collaboration";
import { createProjectJournalMediaDeliveries } from "@/Lib/projects/mediaDelivery";
import { isUuid } from "@/Lib/projects/mediaPaths";
import { listProjectJournalPage } from "@/Lib/projects/queries";
import type { ProjectJournalCursor } from "@/Lib/projects/types";
import { createClient } from "@/Lib/supabase/server";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!isUuid(projectId)) return NextResponse.json({ error: "invalid-project" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const role = await getProjectAccessRole(supabase, projectId);
  if (role === "none") return NextResponse.json({ error: "not-found" }, { status: 404 });

  const url = new URL(request.url);
  const projectDayIdParam = url.searchParams.get("day");
  const projectDayId = projectDayIdParam && projectDayIdParam.length > 0 ? projectDayIdParam : null;
  if (projectDayId !== null && !isUuid(projectDayId)) {
    return NextResponse.json({ error: "invalid-day" }, { status: 400 });
  }

  const cursorDate = url.searchParams.get("cursorDate");
  const cursorId = url.searchParams.get("cursorId");
  if ((cursorDate === null) !== (cursorId === null)) {
    return NextResponse.json({ error: "invalid-cursor" }, { status: 400 });
  }
  let cursor: ProjectJournalCursor | null = null;
  if (cursorDate !== null && cursorId !== null) {
    if (!isUuid(cursorId) || Number.isNaN(Date.parse(cursorDate))) {
      return NextResponse.json({ error: "invalid-cursor" }, { status: 400 });
    }
    cursor = { entryDate: cursorDate, id: cursorId };
  }

  const page = await listProjectJournalPage(supabase, projectId, projectDayId, cursor);
  const deliveries = await createProjectJournalMediaDeliveries(
    supabase,
    page.entries.flatMap((entry) => entry.media),
  );

  return NextResponse.json(
    { ...page, deliveries },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
