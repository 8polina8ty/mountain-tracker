import { NextResponse } from "next/server";

import { createAdminClient } from "@/Lib/supabase/admin";
import { createClient } from "@/Lib/supabase/server";
import { validateCommunityRouteContent } from "@/Lib/tracks/communityRouteContent";

const ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ routeId: string }> }) {
  const { routeId } = await params;
  if (!ROUTE_ID.test(routeId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return NextResponse.json({ error: "auth" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const validation = validateCommunityRouteContent(body);
  if (!validation.ok) return NextResponse.json(validation, { status: 400 });

  const admin = createAdminClient();
  const { data: owned } = await admin.from("mountain_community_routes")
    .select("id").eq("id", routeId).eq("user_id", auth.user.id).eq("status", "published").maybeSingle();
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const editable = validation.value;
  const updatedAt = new Date().toISOString();
  const { data, error } = await admin.from("mountain_community_routes").update({
    title: editable.title,
    summary: editable.summary,
    description: editable.description,
    start_location: editable.start_location,
    route_type: editable.route_type,
    difficulty_system: editable.difficulty_system,
    difficulty_value: editable.difficulty_value,
    best_season: editable.best_season,
    equipment: editable.equipment,
    warnings: editable.warnings,
    conditions_notes: editable.conditions_notes,
    updated_at: updatedAt,
  }).eq("id", routeId).eq("user_id", auth.user.id)
    .select("id,title,summary,description,start_location,route_type,difficulty_system,difficulty_value,best_season,equipment,warnings,conditions_notes,updated_at").single();
  if (error) return NextResponse.json({ error: "save_failed" }, { status: 500 });
  return NextResponse.json({ route: data });
}
