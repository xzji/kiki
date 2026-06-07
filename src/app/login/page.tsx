import { AuthCard } from "@/components/auth/AuthCard";

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[#F5F6F8] px-6 py-10">
      <div className="fixed left-8 top-7 text-[22px] font-bold tracking-tight text-[#1F2328]">KiKi</div>
      <AuthCard />
    </div>
  );
}
