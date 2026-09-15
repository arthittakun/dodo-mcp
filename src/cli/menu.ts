import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

export interface CliMenuProject {
  projectId: string;
  displayName: string;
  root: string;
  available: boolean;
  statusText: string;
}

export interface CliMenuActions {
  listProjects(): CliMenuProject[];
  startupProject(): CliMenuProject | undefined;
  selectProject(projectId: string): CliMenuProject;
  addProject(path: string, displayName?: string): CliMenuProject;
  start(root?: string, tunnel?: boolean): Promise<void>;
  openRemoteConfig(): Promise<void>;
  setupAll(): Promise<void>;
  checkSetup(): Promise<void>;
}

export interface CliMenuStreams {
  input: Readable;
  output: Writable;
}

function write(output: Writable, text: string): void {
  output.write(text);
}

export function menuText(startup: CliMenuProject | undefined): string {
  const selected = startup?.available
    ? `${startup.displayName} (${startup.root})`
    : 'ยังไม่ได้เลือก — server จะรอให้เลือกจาก Local Config';
  return [
    '',
    'DODO Control Center',
    `โปรเจกต์เริ่มต้น: ${selected}`,
    '',
    '  1) เปิด MCP + Local Config + Tunnel (ถาม token ชั่วคราว)',
    '  2) เลือกโปรเจกต์ที่บันทึกไว้ แล้วเปิด MCP + Tunnel',
    '  3) เพิ่มโปรเจกต์จาก absolute path แล้วเปิด MCP + Tunnel',
    '  4) เปิด MCP แบบ local เท่านั้น (ไม่เปิด Tunnel)',
    '  5) เปิด Remote Config ผ่าน Tunnel ชั่วคราว 1 ชั่วโมง',
    '  6) ติดตั้ง/ตรวจ dependencies ทั้งหมด รวม cloudflared',
    '  7) ตรวจ dependencies แบบไม่ติดตั้ง',
    '  0) ออก',
    '',
  ].join('\n');
}

async function pickProject(rl: Interface, output: Writable, projects: CliMenuProject[]): Promise<CliMenuProject | undefined> {
  if (projects.length === 0) {
    write(output, 'ยังไม่มีโปรเจกต์ใน registry ใช้เมนู 3 เพื่อเพิ่มก่อน\n');
    return undefined;
  }
  write(output, '\nโปรเจกต์ที่บันทึกไว้:\n');
  projects.forEach((project, index) => {
    write(output, `  ${index + 1}) ${project.displayName}\n     ${project.root}\n     ${project.available ? 'พร้อมใช้งาน' : project.statusText}\n`);
  });
  const answer = (await rl.question('เลือกหมายเลข (Enter เพื่อย้อนกลับ): ')).trim();
  if (!answer) return undefined;
  const index = Number(answer) - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index >= projects.length) {
    write(output, 'หมายเลขไม่ถูกต้อง\n');
    return undefined;
  }
  const project = projects[index];
  if (!project?.available) {
    write(output, `โปรเจกต์นี้ยังเปิดไม่ได้: ${project?.statusText ?? 'ไม่พบข้อมูล'}\n`);
    return undefined;
  }
  return project;
}

/** Interactive owner menu. It never changes trust, ACLs, OAuth grants or OS permissions. */
export async function runCliMenu(actions: CliMenuActions, streams: CliMenuStreams): Promise<void> {
  const rl = createInterface({ input: streams.input, output: streams.output, terminal: Boolean((streams.output as Writable & { isTTY?: boolean }).isTTY) });
  try {
    for (;;) {
      write(streams.output, menuText(actions.startupProject()));
      const choice = (await rl.question('เลือกเมนู: ')).trim();
      if (choice === '0' || choice.toLowerCase() === 'q') return;
      if (choice === '1') {
        const project = actions.startupProject();
        rl.close();
        await actions.start(project?.available ? project.root : undefined);
        return;
      }
      if (choice === '2') {
        const project = await pickProject(rl, streams.output, actions.listProjects());
        if (!project) continue;
        actions.selectProject(project.projectId);
        rl.close();
        await actions.start(project.root);
        return;
      }
      if (choice === '3') {
        const root = (await rl.question('Absolute path ของโปรเจกต์: ')).trim();
        if (!root) { write(streams.output, 'ยังไม่ได้เพิ่มโปรเจกต์\n'); continue; }
        const displayName = (await rl.question('ชื่อที่แสดง (เว้นว่างเพื่อใช้ชื่อโฟลเดอร์): ')).trim();
        try {
          const project = actions.addProject(root, displayName || undefined);
          write(streams.output, `เพิ่มและเลือก ${project.displayName} แล้ว\n`);
          rl.close();
          await actions.start(project.root);
          return;
        } catch (error) {
          write(streams.output, `เพิ่มโปรเจกต์ไม่สำเร็จ: ${(error as Error).message}\n`);
        }
        continue;
      }
      if (choice === '4') {
        const project = actions.startupProject();
        rl.close();
        await actions.start(project?.available ? project.root : undefined, false);
        return;
      }
      if (choice === '5') {
        rl.close();
        await actions.openRemoteConfig();
        return;
      }
      if (choice === '6') {
        const confirmed = (await rl.question('ติดตั้ง components ที่ขาด รวม cloudflared? พิมพ์ yes เพื่อดำเนินการ: ')).trim().toLowerCase();
        if (confirmed !== 'yes') { write(streams.output, 'ยกเลิกการติดตั้ง\n'); continue; }
        try { await actions.setupAll(); } catch (error) { write(streams.output, `setup ไม่สำเร็จ: ${(error as Error).message}\n`); }
        continue;
      }
      if (choice === '7') {
        try { await actions.checkSetup(); } catch (error) { write(streams.output, `ตรวจ setup ไม่สำเร็จ: ${(error as Error).message}\n`); }
        continue;
      }
      write(streams.output, 'กรุณาเลือก 0–7\n');
    }
  } finally {
    rl.close();
  }
}
