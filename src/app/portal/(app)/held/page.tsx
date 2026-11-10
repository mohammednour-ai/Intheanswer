import { listMessages, listHeldClinics } from "@/lib/portal/queries";
import { MessageList } from "../MessageList";

export default async function HeldPage() {
  const items = await listMessages(["held", "blocked"]);
  const clinics = await listHeldClinics();
  return (
    <section>
      <h1>Held</h1>
      <p className="muted">Items the verification gate or a sending rule stopped, with the reason.</p>
      <MessageList items={items} empty="No held messages." />
      <h2 style={{ marginTop: 32 }}>Held clinics</h2>
      {clinics.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Clinic</th>
                <th>City</th>
                <th>Sector</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {clinics.map((c) => (
                <tr key={c.id as string}>
                  <td>{c.name as string}</td>
                  <td>{c.city as string}</td>
                  <td>{c.sector as string}</td>
                  <td>{c.status_reason as string}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
