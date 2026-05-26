function Indicator() {
  return (
    <div className="absolute bottom-0 h-[14px] left-0 right-0" data-name="Indicator">
      <div className="absolute bg-[#86d1ea] bottom-0 h-[3px] left-[2px] right-[2px] rounded-tl-[100px] rounded-tr-[100px]" data-name="Shape" />
    </div>
  );
}

function TabContents() {
  return (
    <div className="flex-[1_0_0] min-h-px relative" data-name="Tab Contents">
      <div className="flex flex-row items-center justify-center overflow-clip rounded-[inherit] size-full">
        <div className="content-stretch flex gap-[4px] items-center justify-center py-[14px] relative size-full">
          <div className="flex flex-col font-['Roboto:Medium',sans-serif] font-medium justify-center leading-[0] relative shrink-0 text-[#86d1ea] text-[14px] text-center tracking-[0.1px] whitespace-nowrap" style={{ fontVariationSettings: "'wdth' 100" }}>
            <p className="leading-[20px]">Video</p>
          </div>
          <Indicator />
        </div>
      </div>
    </div>
  );
}

function StateLayer() {
  return (
    <div className="flex-[1_0_0] min-h-px relative w-full" data-name="State-layer">
      <div className="flex flex-col items-center justify-end overflow-clip rounded-[inherit] size-full">
        <div className="content-stretch flex flex-col items-center justify-end px-[16px] relative size-full">
          <TabContents />
        </div>
      </div>
    </div>
  );
}

function TabContents1() {
  return (
    <div className="flex-[1_0_0] min-h-px relative" data-name="Tab Contents">
      <div className="flex flex-row items-center justify-center overflow-clip rounded-[inherit] size-full">
        <div className="content-stretch flex gap-[4px] items-center justify-center py-[14px] relative size-full">
          <div className="flex flex-col font-['Roboto:Medium',sans-serif] font-medium justify-center leading-[0] relative shrink-0 text-[#bfc8cc] text-[14px] text-center tracking-[0.1px] whitespace-nowrap" style={{ fontVariationSettings: "'wdth' 100" }}>
            <p className="leading-[20px]">Photos</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StateLayer1() {
  return (
    <div className="flex-[1_0_0] min-h-px relative w-full" data-name="State-layer">
      <div className="flex flex-col items-center justify-end overflow-clip rounded-[inherit] size-full">
        <div className="content-stretch flex flex-col items-center justify-end px-[16px] relative size-full">
          <TabContents1 />
        </div>
      </div>
    </div>
  );
}

function TabContents2() {
  return (
    <div className="flex-[1_0_0] min-h-px relative" data-name="Tab Contents">
      <div className="flex flex-row items-center justify-center overflow-clip rounded-[inherit] size-full">
        <div className="content-stretch flex gap-[4px] items-center justify-center py-[14px] relative size-full">
          <div className="flex flex-col font-['Roboto:Medium',sans-serif] font-medium justify-center leading-[0] relative shrink-0 text-[#bfc8cc] text-[14px] text-center tracking-[0.1px] whitespace-nowrap" style={{ fontVariationSettings: "'wdth' 100" }}>
            <p className="leading-[20px]">Audio</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StateLayer2() {
  return (
    <div className="flex-[1_0_0] min-h-px relative w-full" data-name="State-layer">
      <div className="flex flex-col items-center justify-end overflow-clip rounded-[inherit] size-full">
        <div className="content-stretch flex flex-col items-center justify-end px-[16px] relative size-full">
          <TabContents2 />
        </div>
      </div>
    </div>
  );
}

function TabGroup() {
  return (
    <div className="content-stretch cursor-pointer flex flex-[1_0_0] items-start min-h-px relative w-full" data-name="Tab group">
      <div className="bg-[#0f1416] content-stretch flex flex-[1_0_0] flex-col h-full items-center justify-end min-w-px overflow-clip relative" data-name="Tab 1">
        <StateLayer />
      </div>
      <div className="bg-[#0f1416] content-stretch flex flex-[1_0_0] flex-col h-full items-center justify-end min-w-px overflow-clip relative" data-name="Tab 2">
        <StateLayer1 />
      </div>
      <div className="bg-[#0f1416] content-stretch flex flex-[1_0_0] flex-col h-full items-center justify-end min-w-px overflow-clip relative" data-name="Tab 3">
        <StateLayer2 />
      </div>
    </div>
  );
}

export default function Tabs() {
  return (
    <div className="bg-[#0f1416] content-stretch flex flex-col items-start relative size-full" data-name="Tabs">
      <TabGroup />
      <div className="content-stretch flex flex-col items-start justify-center relative shrink-0 w-full" data-name="Divider">
        <div className="h-0 relative shrink-0 w-full" data-name="Divider">
          <div className="absolute inset-[-1px_0_0_0]">
            <svg className="block size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 390 1">
              <line id="Divider" stroke="var(--stroke-0, #CAC4D0)" x2="390" y1="0.5" y2="0.5" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}