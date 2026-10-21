import { redirect } from "next/navigation";

// Links antigos (/sala/x/transmitir) agora vão para a sala única.
export default async function Old({ params }) {
  const { id } = await params;
  redirect(`/sala/${id}`);
}
