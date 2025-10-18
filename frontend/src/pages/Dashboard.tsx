import React from "react";
import CommoditiesTicker from "../components/CommoditiesTicker";
import GeeDashboard from "../components/GeeDashboard";
import AISLive from "../components/AISLive";
import AISlive from "../components/AISLive";

const Dashboard: React.FC = () => {
  return (
    <div className="w-full min-h-screen flex flex-col bg-gray-100">
      {/* Commodities Ticker */}
      <header className="sticky top-0 z-10">
        <CommoditiesTicker />
      </header>

      {/* Main content area */}
      <main className="flex-1 p-4 space-y-6">
        {/* Earth Engine App */}
        <section className="bg-white rounded-xl shadow-md p-4">
          <h2 className="text-lg font-semibold mb-2">Global Satellite Dashboard</h2>
          <GeeDashboard showControls height="70vh" />
        </section>

        {/* AIS Live */}
        <section className="bg-white rounded-xl shadow-md p-4">
          <h2 className="text-lg font-semibold mb-2">Live Ship Tracking (AIS)</h2>
          <AISlive />
        </section>
      </main>
    </div>
  );
};

export default Dashboard;